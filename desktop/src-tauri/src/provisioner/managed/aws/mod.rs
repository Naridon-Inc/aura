//! Making a machine on EC2.
//!
//! The first implementation of [`CloudDriver`], and the one the decision of
//! record picks for managed v1: the same ssh+tmux runtime a box somebody brought
//! runs, on a box Aura made instead. Nothing above the `Place` seam is told
//! which of those it got — that is the entire claim of the managed arm, and it
//! only holds because this file produces the same four address fields the BYO
//! path produces.
//!
//! The recipe is `aura-runner/aws/provision.sh`, which already works: an ARM
//! Ubuntu image, a gp3 root volume big enough for a cold build, a security group
//! and a key pair that the operator set up once. What that script does with the
//! `aws` CLI, this does with signed requests — same calls, same order, same
//! arguments — because a managed box that diverged from the box the team already
//! runs would fail in ways nobody has seen before.
//!
//! ## What this deliberately does not do
//!
//! It does not **create** the network or the key. Both are `ensure_*` in the
//! trait and both are resolve-only here, for reasons that are not the same: what
//! may reach a machine Aura hosts is a decision with a blast radius and should
//! not be made at whatever hour the first member clicked "create", and creating
//! a key pair is the one EC2 call that hands back private key material — which
//! this process is the wrong place for. Aura holds a managed machine's key
//! server-side and brokers the connection; the laptop only ever learns the
//! reference.
//!
//! It also does not open a connection to the machine it made. Whether a box
//! answers is `Place`'s question, asked identically for every mode, and a second
//! transport in here is exactly what the single-door guard exists to prevent.

// Both are visible to the rest of the provisioner rather than to this file
// alone, because the grant arm reaches a customer's own account through the same
// signed transport and reads the same XML back. A second copy of either would be
// a second thing to get subtly wrong, and the failure mode of "subtly wrong"
// against a signing routine is an opaque 403 that names no byte.
pub(in crate::provisioner) mod parse;
pub(in crate::provisioner) mod query;

use async_trait::async_trait;
use base64::Engine as _;

use crate::aws_sigv4::AwsCredentials;

use super::driver::{
    CloudDriver, DriverError, DriverResult, Instance, InstanceId, InstanceState, KeyPair,
    NetworkRef,
};
use super::plan::LaunchPlan;
use super::settings::AWS_EC2;
use query::{Endpoint, Query};

/// The root volume's device on the images this targets. Ubuntu's own AMIs boot
/// from `/dev/sda1`; naming a device the image does not have is accepted at
/// launch and produces a machine with the image's default 8 GB disk, which is
/// the sort of failure that only shows up when a build runs out of room.
const ROOT_DEVICE: &str = "/dev/sda1";

/// The tag that says Aura made this. Not decoration: it is how a person looking
/// at the cloud's own console, or a script cleaning up after a bad afternoon,
/// can tell a machine Aura is responsible for from one somebody made by hand.
const MADE_BY_AURA: &str = "aura:managed";

/// EC2's own name for "you asked about a machine that isn't there".
const NO_SUCH_INSTANCE: &str = "InvalidInstanceID.NotFound";

/// EC2's own name for a handle that could never have been one of its ids.
const MALFORMED_INSTANCE: &str = "InvalidInstanceID.Malformed";

pub struct Ec2Driver {
    endpoint: Endpoint,
}

impl Ec2Driver {
    /// Build a driver for one region, with the credential this process was
    /// given. Fails with a sentence when there is no credential — that is an
    /// install that cannot make machines, not a bug.
    pub fn new(region: &str) -> Result<Self, String> {
        Ok(Self {
            endpoint: Endpoint::from_environment(region)?,
        })
    }

    /// The same driver pointed at a different account, on a credential somebody
    /// else's account handed back.
    ///
    /// This is the whole of what the grant arm needs from this file. The calls a
    /// customer's account allows are a subset of the ones below — see
    /// [`crate::provisioner::grant::permissions`] for exactly which, and which
    /// are deliberately refused — and the ones outside that subset fail as
    /// refusals with the account's own sentence, which is the right answer: the
    /// permission is the customer's to grant and not ours to work around.
    pub(in crate::provisioner) fn with_credentials(region: &str, creds: AwsCredentials) -> Self {
        Self {
            endpoint: Endpoint::new(region, creds),
        }
    }
}

#[async_trait]
impl CloudDriver for Ec2Driver {
    fn substrate(&self) -> &'static str {
        AWS_EC2
    }

    async fn ensure_network(&self, plan: &LaunchPlan) -> DriverResult<NetworkRef> {
        let answer = self.endpoint.call(describe_network(plan)).await?;
        let group = parse::element(&answer, "securityGroupInfo")
            .and_then(|set| parse::element(set, "item"))
            .and_then(|item| parse::text(item, "groupId"));
        match group {
            Some(id) => Ok(NetworkRef(id)),
            // A describe filtered by name answers with an empty set rather than
            // refusing, so the refusal is minted here — under EC2's own code for
            // this exact condition, so that somebody searching the code they were
            // shown lands on the page that explains it.
            None => Err(DriverError::Refused {
                code: "InvalidGroup.NotFound".to_string(),
                message: format!(
                    "the network {:?} isn't in this account and region — Aura won't open one \
                     on its own, because what may reach a machine it hosts is not a default",
                    plan.security_group
                ),
            }),
        }
    }

    async fn ensure_key(&self, plan: &LaunchPlan) -> DriverResult<KeyPair> {
        // Named directly rather than filtered, because EC2 refuses this one
        // itself with `InvalidKeyPair.NotFound` — its sentence about the missing
        // key is better than any sentence we would write about an empty list.
        let query = Query::action("DescribeKeyPairs").list("KeyName", [plan.key_pair.as_str()]);
        let answer = self.endpoint.call(query).await?;
        let named = parse::element(&answer, "keySet")
            .and_then(|set| parse::element(set, "item"))
            .and_then(|item| parse::text(item, "keyName"));
        let Some(launch_name) = named else {
            return Err(DriverError::Unreadable(format!(
                "the cloud accepted the question about the key {:?} and answered without naming it",
                plan.key_pair
            )));
        };
        Ok(KeyPair {
            launch_name,
            // Straight from the plan, and never from the cloud: this is what
            // gets written on the machine's row, and it is a reference to a key
            // Aura holds rather than anything EC2 knows about.
            reference: plan.key_ref.clone(),
        })
    }

    async fn launch(
        &self,
        plan: &LaunchPlan,
        network: &NetworkRef,
        key: &KeyPair,
    ) -> DriverResult<Instance> {
        let answer = self.endpoint.call(run_instances(plan, network, key)).await?;
        let Some(item) = first_instance(&answer) else {
            return Err(DriverError::Unreadable(
                "the cloud accepted the machine and then described no machine".to_string(),
            ));
        };
        read_instance(item)
    }

    async fn describe(&self, id: &InstanceId) -> DriverResult<Instance> {
        must_be_an_ec2_id(id)?;
        let query = Query::action("DescribeInstances").list("InstanceId", [id.as_str()]);
        let answer = match self.endpoint.call(query).await {
            Ok(answer) => answer,
            // Not an error to report. The trait's `Gone` covers "ended" and
            // "never existed" together precisely so a caller does not have to
            // race the cloud's own bookkeeping, and this is that race: a machine
            // ended minutes ago stops being describable at all.
            Err(DriverError::Refused { ref code, .. }) if code == NO_SUCH_INSTANCE => {
                return Ok(gone(id))
            }
            Err(e) => return Err(e),
        };
        match first_instance(&answer) {
            Some(item) => read_instance(item),
            None => Ok(gone(id)),
        }
    }

    async fn locate(&self, address: &str) -> DriverResult<Option<InstanceId>> {
        let address = address.trim();
        if address.is_empty() {
            return Ok(None);
        }
        // Two questions rather than one, because a filter set is ANDed: asking
        // for "the public address OR the private one" in a single call asks for
        // a machine that has the same value in both fields, which is no machine
        // at all. Asked in turn, the first that answers is the machine.
        for by in address_filters(address) {
            let answer = self.endpoint.call(machine_at(by, address)).await?;
            if let Some(item) = first_instance(&answer) {
                return read_instance(item).map(|seen| Some(seen.id));
            }
        }
        Ok(None)
    }

    async fn stop(&self, id: &InstanceId) -> DriverResult<()> {
        must_be_an_ec2_id(id)?;
        // Plain `StopInstances`, with no `Force` and no `Hibernate`. Force skips
        // the guest's own shutdown, which is how a filesystem ends up needing a
        // check on the way back; hibernate needs an image and a volume set up for
        // it, and a machine that was never prepared for it refuses at this call
        // rather than at provisioning time — which would put the refusal in front
        // of a member who asked for nothing but to walk away.
        let query = Query::action("StopInstances").list("InstanceId", [id.as_str()]);
        match self.endpoint.call(query).await {
            Ok(_) => Ok(()),
            // The caller wanted a machine that is not running. A machine that no
            // longer exists is not running, and reporting a failure here would
            // leave the idle sweep retrying forever against a box somebody ended
            // by hand.
            Err(DriverError::Refused { ref code, .. }) if code == NO_SUCH_INSTANCE => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn start(&self, id: &InstanceId) -> DriverResult<Instance> {
        must_be_an_ec2_id(id)?;
        let query = Query::action("StartInstances").list("InstanceId", [id.as_str()]);
        let answer = self.endpoint.call(query).await?;
        // `StartInstances` answers with the state it is moving *to*, and with no
        // address — the box gets a new public one on every start, and it does not
        // have it yet. So the answer is read for its id and its state and then
        // polled, rather than being handed back as a place somebody could dial.
        match first_instance(&answer) {
            Some(item) => read_instance(item),
            None => Err(DriverError::Unreadable(
                "the cloud accepted the start and then described no machine".to_string(),
            )),
        }
    }

    async fn terminate(&self, id: &InstanceId) -> DriverResult<()> {
        must_be_an_ec2_id(id)?;
        let query = Query::action("TerminateInstances").list("InstanceId", [id.as_str()]);
        match self.endpoint.call(query).await {
            Ok(_) => Ok(()),
            // The caller wanted no machine and there is no machine. Reporting a
            // failure here would leave a place nobody can get rid of: every
            // retry asks about an instance that is already gone and fails the
            // same way.
            Err(DriverError::Refused { ref code, .. }) if code == NO_SUCH_INSTANCE => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Ask about the network the plan names.
///
/// An operator may write either the group's name or its id, and both are things
/// people copy out of the console. They are looked up differently — a name is a
/// filter, an id is an id — so the shape of the value decides the question
/// rather than a second settings field nobody would keep in step.
fn describe_network(plan: &LaunchPlan) -> Query {
    let query = Query::action("DescribeSecurityGroups");
    if plan.security_group.starts_with("sg-") {
        query.list("GroupId", [plan.security_group.as_str()])
    } else {
        query
            .set("Filter.1.Name", "group-name")
            .list("Filter.1.Value", [plan.security_group.as_str()])
    }
}

/// Which fields of a machine could hold the address somebody typed.
///
/// An address is either a number or a name, and EC2 files the two under
/// different filters — so guessing wrong finds nothing and reports that a
/// machine the customer is looking at is not in their account. Both spellings of
/// each are tried because a box reached from inside its own network answers on
/// the private one and the same box reached from a laptop answers on the public
/// one, and which of those the customer typed depends on where they were sitting.
fn address_filters(address: &str) -> &'static [&'static str] {
    if address.parse::<std::net::IpAddr>().is_ok() {
        &["ip-address", "private-ip-address"]
    } else {
        &["dns-name", "private-dns-name"]
    }
}

/// Ask which running machine answers on an address.
///
/// Narrowed to running ones on purpose. A machine that ended keeps its record —
/// and its old address — in the cloud's own answers for an hour afterwards, so
/// an unnarrowed question can hand back the handle of a box that no longer
/// exists, which would then be written onto a row as the machine to stop. The
/// customer is linking a box they are working on, so running is both the honest
/// filter and the true one.
fn machine_at(by: &str, address: &str) -> Query {
    Query::action("DescribeInstances")
        .set("Filter.1.Name", by)
        .list("Filter.1.Value", [address])
        .set("Filter.2.Name", "instance-state-name")
        .list("Filter.2.Value", ["running"])
}

/// The request that makes the machine.
fn run_instances(plan: &LaunchPlan, network: &NetworkRef, key: &KeyPair) -> Query {
    Query::action("RunInstances")
        .set("ImageId", plan.image_id.as_str())
        .set("InstanceType", plan.instance_type.as_str())
        // Exactly one. A launch that could return two would bill for two and the
        // second would never be recorded anywhere Aura can find it again.
        .set("MinCount", "1")
        .set("MaxCount", "1")
        .set("KeyName", key.launch_name.as_str())
        .list("SecurityGroupId", [network.0.as_str()])
        .set("BlockDeviceMapping.1.DeviceName", ROOT_DEVICE)
        .set("BlockDeviceMapping.1.Ebs.VolumeType", "gp3")
        .set(
            "BlockDeviceMapping.1.Ebs.VolumeSize",
            plan.disk_gb.to_string(),
        )
        // The disk goes when the machine goes. A volume that outlives its
        // instance is a charge nobody is watching for, on data that belongs to a
        // machine that no longer exists.
        .set("BlockDeviceMapping.1.Ebs.DeleteOnTermination", "true")
        // The metadata service, locked to session tokens. The boot script is
        // readable through that service, so anything on the box that can be
        // talked into fetching a URL could otherwise read it; requiring a token
        // means a request has to be made on purpose, from the box, by something
        // that already runs there.
        .set("MetadataOptions.HttpTokens", "required")
        .set("MetadataOptions.HttpPutResponseHopLimit", "1")
        .set(
            "UserData",
            base64::engine::general_purpose::STANDARD.encode(plan.user_data.as_bytes()),
        )
        // Tagged at launch rather than afterwards: a tag applied in a second
        // call is a tag missing on every machine whose second call failed, and
        // those are exactly the machines somebody later has to identify.
        .set("TagSpecification.1.ResourceType", "instance")
        .set("TagSpecification.1.Tag.1.Key", "Name")
        .set("TagSpecification.1.Tag.1.Value", plan.name.as_str())
        .set("TagSpecification.1.Tag.2.Key", MADE_BY_AURA)
        .set("TagSpecification.1.Tag.2.Value", "true")
}

/// The first `<item>` of the first `<instancesSet>` in an answer.
///
/// One reader for two response shapes: `RunInstances` puts the set at the top,
/// `DescribeInstances` nests it inside a reservation. Since we only ever ask
/// about one machine at a time, the first instance in the first set is the
/// machine — and looking for the set by name rather than by path is what lets
/// both shapes share this.
fn first_instance(xml: &str) -> Option<&str> {
    parse::element(xml, "instancesSet").and_then(|set| parse::element(set, "item"))
}

/// Read one machine out of the element that describes it.
fn read_instance(item: &str) -> DriverResult<Instance> {
    let Some(id) = parse::text(item, "instanceId") else {
        return Err(DriverError::Unreadable(
            "the cloud described a machine without saying which one".to_string(),
        ));
    };
    // EC2 spells the same fact two ways depending on which call answered.
    // `RunInstances` and `DescribeInstances` say `instanceState`; the calls that
    // *change* a machine — `StartInstances`, `StopInstances` — say `currentState`
    // beside a `previousState`, because the interesting thing about them is the
    // transition. Read as one field here rather than in two readers: they are one
    // fact, and a second reader is where the two would drift.
    let word = parse::element(item, "instanceState")
        .or_else(|| parse::element(item, "currentState"))
        .and_then(|state| parse::text(state, "name"))
        .ok_or_else(|| {
            DriverError::Unreadable(format!("the cloud didn't say what {id} is doing"))
        })?;
    Ok(Instance {
        id: InstanceId(id),
        state: state_of(&word)?,
        host: reachable_at(item),
    })
}

/// Refuse a handle EC2 could never have issued, before asking it about one.
///
/// An id reaches this driver from a caller above the seam, which may be holding
/// a stale record, a handle from another substrate, or a string somebody typed.
/// Sending it on would spend a signed request to be told the same thing, and —
/// on the call that ends machines — it would be a real request against somebody
/// else's account made on the strength of a value nobody checked. The shape is
/// EC2's own (`i-` and eight or seventeen hex digits) and so is the code, so a
/// person searching what they were shown lands on the page that explains it.
fn must_be_an_ec2_id(id: &InstanceId) -> DriverResult<()> {
    let looks_right = id
        .as_str()
        .strip_prefix("i-")
        .is_some_and(|rest| matches!(rest.len(), 8 | 17) && rest.bytes().all(|b| b.is_ascii_hexdigit()));
    if looks_right {
        Ok(())
    } else {
        Err(DriverError::Refused {
            code: MALFORMED_INSTANCE.to_string(),
            message: format!(
                "{:?} isn't a machine Aura made in this cloud",
                id.as_str()
            ),
        })
    }
}

/// A machine that is not there.
fn gone(id: &InstanceId) -> Instance {
    Instance {
        id: id.clone(),
        state: InstanceState::Gone,
        host: None,
    }
}

/// EC2's word for what a machine is doing, in the driver's five.
///
/// A word we do not know is [`DriverError::Unreadable`] rather than a guess.
/// Guessing means picking between "keep waiting" and "give up" on no
/// information, and both are wrong in a way that looks like the machine's fault.
fn state_of(word: &str) -> DriverResult<InstanceState> {
    Ok(match word {
        "pending" => InstanceState::Starting,
        "running" => InstanceState::Running,
        // Two words for two moments, and they are not interchangeable. A machine
        // that is `stopping` is going to sleep and will be back with its disk;
        // one that is `shutting-down` is being destroyed. Read as one state, a
        // place on its way to sleep shows up in the app as a teardown.
        "stopping" => InstanceState::Stopping,
        "shutting-down" => InstanceState::Ending,
        "stopped" => InstanceState::Stopped,
        "terminated" => InstanceState::Gone,
        other => {
            return Err(DriverError::Unreadable(format!(
                "the cloud says the machine is {other:?}, which Aura doesn't know how to read"
            )))
        }
    })
}

/// Where the machine can be reached, if it can be yet.
///
/// The public name first and the address second. The name resolves to the
/// public address from outside and the private one from within the same network,
/// which is the behaviour anything reaching this box from more than one side
/// wants; the address is the fallback for a network configured without public
/// names, where there is no name to have.
fn reachable_at(item: &str) -> Option<String> {
    parse::text(item, "dnsName").or_else(|| parse::text(item, "ipAddress"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> LaunchPlan {
        LaunchPlan {
            name: "crew-box".into(),
            region: "eu-central-1".into(),
            image_id: "ami-0123456789abcdef0".into(),
            instance_type: "t4g.large".into(),
            disk_gb: 40,
            ssh_user: "ubuntu".into(),
            key_pair: "aura-managed".into(),
            key_ref: "managed:2f9c1f8e-0b2a-4d55-9a44-1c2d3e4f5a6b".into(),
            security_group: "aura-managed".into(),
            repo_path: Some("/home/ubuntu/aura-sovereign".into()),
            agents: vec!["claude".into()],
            user_data: "#!/bin/bash\napt-get update -y\n".into(),
        }
    }

    /// What `RunInstances` answers with, trimmed to what is read.
    const LAUNCHED: &str = r#"<RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <instancesSet>
    <item>
      <instanceId>i-0abc123</instanceId>
      <instanceState><code>0</code><name>pending</name></instanceState>
      <dnsName/>
    </item>
  </instancesSet>
</RunInstancesResponse>"#;

    #[test]
    fn the_machine_is_asked_for_exactly_once() {
        // Two would be billed, and the second would never be written down
        // anywhere Aura could find it again to end it.
        let body = run_instances(&plan(), &NetworkRef("sg-1".into()), &key()).body();
        assert!(body.contains("MinCount=1"), "{body}");
        assert!(body.contains("MaxCount=1"), "{body}");
    }

    fn key() -> KeyPair {
        KeyPair {
            launch_name: "aura-managed".into(),
            reference: "managed:2f9c1f8e-0b2a-4d55-9a44-1c2d3e4f5a6b".into(),
        }
    }

    #[test]
    fn the_disk_is_the_one_the_plan_asked_for_and_it_goes_when_the_machine_does() {
        // A cold build does not fit in the image's own 8 GB, and a volume that
        // outlives its instance is a charge nobody is watching for.
        let body = run_instances(&plan(), &NetworkRef("sg-1".into()), &key()).body();
        assert!(body.contains("BlockDeviceMapping.1.Ebs.VolumeSize=40"), "{body}");
        assert!(
            body.contains("BlockDeviceMapping.1.Ebs.DeleteOnTermination=true"),
            "{body}"
        );
        assert!(body.contains(&format!("DeviceName={}", encoded(ROOT_DEVICE))), "{body}");
    }

    fn encoded(raw: &str) -> String {
        raw.replace('/', "%2F")
    }

    #[test]
    fn the_boot_script_travels_as_the_cloud_expects_and_carries_no_key() {
        // Base64 with padding — the one encoding EC2 accepts here. The URL-safe
        // variant this crate uses elsewhere is silently a different string, and
        // a boot script that decoded to noise produces a machine that comes up
        // and does nothing anybody asked for.
        let body = run_instances(&plan(), &NetworkRef("sg-1".into()), &key()).body();
        let expected = base64::engine::general_purpose::STANDARD.encode(plan().user_data.as_bytes());
        assert!(body.contains(&format!("UserData={}", expected.replace('=', "%3D"))), "{body}");
        // And nothing about the key goes to the box. The reference is for the
        // machine's row; the key itself never enters this process at all.
        assert!(!body.contains(&plan().key_ref.replace(':', "%3A")), "{body}");
    }

    #[test]
    fn the_machine_is_named_and_marked_as_aura_made() {
        // The board polls for the name; a person cleaning up a bad afternoon in
        // the cloud's own console needs the mark.
        let body = run_instances(&plan(), &NetworkRef("sg-1".into()), &key()).body();
        assert!(body.contains("TagSpecification.1.Tag.1.Value=crew-box"), "{body}");
        assert!(
            body.contains(&format!(
                "TagSpecification.1.Tag.2.Key={}",
                MADE_BY_AURA.replace(':', "%3A")
            )),
            "{body}"
        );
    }

    #[test]
    fn the_boot_script_cannot_be_read_by_anything_that_wanders_onto_the_box() {
        // The script is served by the metadata service. Without a token
        // requirement, anything on the box that can be talked into fetching a
        // URL can read it.
        let body = run_instances(&plan(), &NetworkRef("sg-1".into()), &key()).body();
        assert!(body.contains("MetadataOptions.HttpTokens=required"), "{body}");
    }

    #[test]
    fn a_network_is_looked_up_the_way_it_was_written() {
        // Both spellings are things people copy out of the console, and they are
        // looked up differently. Getting this wrong finds nothing and reports
        // that the operator's own group is not in their account.
        let by_name = describe_network(&plan()).body();
        assert!(by_name.contains("Filter.1.Name=group-name"), "{by_name}");
        assert!(by_name.contains("Filter.1.Value.1=aura-managed"), "{by_name}");

        let mut by_id = plan();
        by_id.security_group = "sg-0123456789abcdef0".into();
        let body = describe_network(&by_id).body();
        assert!(body.contains("GroupId.1=sg-0123456789abcdef0"), "{body}");
        assert!(!body.contains("Filter."), "{body}");
    }

    #[test]
    fn a_launched_machine_is_read_back_with_its_id_and_state() {
        let item = first_instance(LAUNCHED).expect("an instance");
        let seen = read_instance(item).expect("a readable machine");
        assert_eq!(seen.id, InstanceId("i-0abc123".into()));
        assert_eq!(seen.state, InstanceState::Starting);
        // Accepted, not ready. An empty `<dnsName/>` is the cloud saying the
        // address has not been assigned yet, which is why the step above polls.
        assert_eq!(seen.host, None);
    }

    #[test]
    fn a_machine_is_reached_by_name_before_address() {
        // The name resolves to the public address from outside and the private
        // one from within the same network. The address is the fallback for a
        // network that hands out no names.
        let both = "<item><instanceId>i-1</instanceId>\
                    <instanceState><name>running</name></instanceState>\
                    <dnsName>ec2-198-51-100-7.compute.amazonaws.com</dnsName>\
                    <ipAddress>198.51.100.7</ipAddress></item>";
        assert_eq!(
            read_instance(both).expect("readable").host.as_deref(),
            Some("ec2-198-51-100-7.compute.amazonaws.com")
        );
        let address_only = "<item><instanceId>i-1</instanceId>\
                            <instanceState><name>running</name></instanceState>\
                            <dnsName/><ipAddress>198.51.100.7</ipAddress></item>";
        assert_eq!(
            read_instance(address_only).expect("readable").host.as_deref(),
            Some("198.51.100.7")
        );
    }

    #[test]
    fn every_word_the_cloud_uses_for_a_state_reads_as_one_of_the_six() {
        for (word, expected) in [
            ("pending", InstanceState::Starting),
            ("running", InstanceState::Running),
            ("stopping", InstanceState::Stopping),
            ("shutting-down", InstanceState::Ending),
            ("stopped", InstanceState::Stopped),
            ("terminated", InstanceState::Gone),
        ] {
            assert_eq!(state_of(word).expect(word), expected, "{word}");
        }
    }

    #[test]
    fn going_to_sleep_and_being_destroyed_are_not_the_same_word() {
        // They were one state while the only way down was permanent. Folded back
        // together, a place on its way to sleep shows up in the app as a
        // teardown — and the two differ by whether the disk comes back.
        assert_ne!(
            state_of("stopping").expect("stopping"),
            state_of("shutting-down").expect("shutting-down")
        );
    }

    /// What `StartInstances` answers with. Note `currentState` rather than
    /// `instanceState`, and no address at all: a machine gets its public one
    /// partway through boot, which is why the step above polls.
    const STARTED: &str = r#"<StartInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <instancesSet>
    <item>
      <instanceId>i-0abc123</instanceId>
      <currentState><code>0</code><name>pending</name></currentState>
      <previousState><code>80</code><name>stopped</name></previousState>
    </item>
  </instancesSet>
</StartInstancesResponse>"#;

    #[test]
    fn the_answer_to_a_start_is_read_even_though_it_spells_the_state_differently() {
        // EC2 says `instanceState` when it describes and `currentState` when it
        // changes. Read by only one of those names, every wake would come back
        // "the cloud didn't say what it is doing" — for an answer that said so
        // perfectly clearly.
        let item = first_instance(STARTED).expect("an instance");
        let seen = read_instance(item).expect("a readable machine");
        assert_eq!(seen.id, InstanceId("i-0abc123".into()));
        assert_eq!(seen.state, InstanceState::Starting);
        assert_eq!(seen.host, None, "a starting machine has no address yet");
    }

    #[test]
    fn a_handle_this_cloud_never_issued_is_refused_before_a_stop_or_a_start_too() {
        // Same guard as `terminate`, and it earns it twice over: `stop` and
        // `start` are both real requests against a real account, made on the
        // strength of a value that reached this driver from above the seam.
        for handle in ["nothing-registered-here", "i-zzzzzzzz", ""] {
            assert!(
                must_be_an_ec2_id(&InstanceId(handle.into())).is_err(),
                "{handle:?} was accepted as a machine this cloud made"
            );
        }
    }

    #[test]
    fn a_state_nobody_has_seen_is_admitted_rather_than_guessed_at() {
        // Guessing means choosing between "keep waiting" and "give up" on no
        // information, and both are wrong in a way that looks like the machine's
        // fault rather than ours.
        let Err(DriverError::Unreadable(why)) = state_of("hibernating") else {
            panic!("an unknown state was quietly turned into one of ours");
        };
        assert!(why.contains("hibernating"), "{why}");
    }

    #[test]
    fn an_answer_describing_no_machine_is_not_a_machine() {
        // `DescribeInstances` for something that ended answers with an empty
        // reservation set, and reading that as a machine would produce a place
        // with no id in it.
        assert!(first_instance("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>").is_none());
    }

    #[test]
    fn a_handle_this_cloud_never_issued_is_refused_before_it_is_sent() {
        // The one that matters is `terminate`: a request made against somebody
        // else's account on the strength of a value nobody checked. Ids reach
        // this driver from callers that may hold a stale record, a handle from
        // another substrate, or a string somebody typed.
        for handle in ["nothing-registered-here", "", "i-", "i-zzzzzzzz", "sg-0abc1234"] {
            let refused = must_be_an_ec2_id(&InstanceId(handle.into()));
            let Err(DriverError::Refused { code, .. }) = refused else {
                panic!("{handle:?} was accepted as a machine this cloud made");
            };
            assert_eq!(code, MALFORMED_INSTANCE);
        }
        // Both lengths EC2 has issued over the years — the old eight-digit ids
        // and the current seventeen.
        for real in ["i-0abc1234", "i-0123456789abcdef0"] {
            must_be_an_ec2_id(&InstanceId(real.into())).unwrap_or_else(|e| {
                panic!("{real} is a machine id and was refused: {e}");
            });
        }
    }

    #[test]
    fn an_address_is_looked_up_under_the_field_that_could_hold_it() {
        // A number and a name are filed under different filters. Guessing wrong
        // finds nothing and reports that a machine the customer is looking at is
        // not in their account.
        let numbered = vec!["ip-address", "private-ip-address"];
        assert_eq!(address_filters("198.51.100.7").to_vec(), numbered);
        assert_eq!(address_filters("10.0.0.4").to_vec(), numbered);
        assert_eq!(
            address_filters("ec2-198-51-100-7.compute.amazonaws.com").to_vec(),
            vec!["dns-name", "private-dns-name"]
        );
    }

    #[test]
    fn a_machine_is_only_looked_for_among_the_ones_that_are_running() {
        // A terminated machine keeps its record — and its old address — in the
        // cloud's answers for an hour. Unnarrowed, this hands back the handle of
        // a box that no longer exists, and that handle then gets written onto a
        // row as the machine to stop.
        let body = machine_at("ip-address", "198.51.100.7").body();
        assert!(body.contains("Filter.1.Name=ip-address"), "{body}");
        assert!(body.contains("Filter.1.Value.1=198.51.100.7"), "{body}");
        assert!(body.contains("Filter.2.Name=instance-state-name"), "{body}");
        assert!(body.contains("Filter.2.Value.1=running"), "{body}");
    }

    #[test]
    fn a_machine_described_without_an_id_is_ours_to_fix_rather_than_theirs() {
        let Err(DriverError::Unreadable(_)) =
            read_instance("<item><instanceState><name>running</name></instanceState></item>")
        else {
            panic!("an unreadable answer was accepted");
        };
    }
}
