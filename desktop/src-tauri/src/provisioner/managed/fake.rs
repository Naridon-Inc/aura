//! A cloud that costs nothing and starts nothing.
//!
//! The steps above are the part worth proving: that the four fields come back,
//! that each failure names its own step, that a box which never comes up ends
//! in a sentence rather than a spinner. None of that needs a real machine, and
//! every one of those cases is either slow, expensive or impossible to arrange
//! on one — you cannot ask a region to be out of capacity on demand.
//!
//! So the driver seam has a second implementation whose entire job is to be
//! asked those questions. It is scripted rather than clever: it answers what it
//! was told to answer, and it remembers what it was asked, which is what lets a
//! test assert on the ORDER of the steps as well as their result.
//!
//! Test-only on purpose. A fake that shipped would be a cloud somebody could
//! configure by accident, and "it said it made a machine" is the one failure
//! this whole module is arranged to prevent.

use std::sync::Mutex;

use async_trait::async_trait;

use super::driver::{
    CloudDriver, DriverError, DriverResult, Instance, InstanceId, InstanceState, KeyPair,
    NetworkRef,
};
use super::plan::LaunchPlan;

/// A point at which the scripted cloud can be told to refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Network,
    Key,
    Launch,
    Describe,
    Locate,
    Stop,
    Start,
    Terminate,
}

#[derive(Debug)]
struct Script {
    /// What was asked, in the order it was asked.
    calls: Vec<String>,
    describes: u32,
    /// The describe on which the machine becomes usable.
    running_after: u32,
    /// What the machine does instead of coming up, when it does something else.
    instead: Instead,
    /// Where to refuse, and in whose words.
    refuse: Option<(Stage, String, String)>,
}

/// The ways a machine fails to become a machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Instead {
    /// It comes up, as asked.
    ComesUp,
    /// It ends on the way.
    Ends,
    /// It runs and is never given an address.
    StaysUnreachable,
    /// It sits in one state forever — for reading a state back rather than
    /// waiting on one.
    Sits(InstanceState),
}

#[derive(Debug)]
pub struct FakeCloud {
    script: Mutex<Script>,
}

impl FakeCloud {
    /// The address a made machine answers on. A documentation address from
    /// RFC 5737, so nothing in this file is ever a real host somebody could
    /// find themselves connecting to.
    pub const HOST: &'static str = "203.0.113.10";
    /// The handle the scripted cloud gives every machine it makes.
    pub const INSTANCE: &'static str = "i-0fake0000000000";

    /// A cloud where everything works and the machine is up by the first look.
    pub fn new() -> Self {
        Self {
            script: Mutex::new(Script {
                calls: Vec::new(),
                describes: 0,
                running_after: 1,
                instead: Instead::ComesUp,
                refuse: None,
            }),
        }
    }

    /// A cloud that refuses at `stage`, in its own words.
    pub fn refusing(self, stage: Stage, code: &str, message: &str) -> Self {
        self.script
            .lock()
            .expect("the scripted cloud is single-threaded")
            .refuse = Some((stage, code.to_string(), message.to_string()));
        self
    }

    /// A cloud whose machine is only usable on the `nth` look.
    pub fn running_after(self, nth: u32) -> Self {
        self.script
            .lock()
            .expect("the scripted cloud is single-threaded")
            .running_after = nth;
        self
    }

    /// A cloud whose machine ends on the way up.
    pub fn dying(self) -> Self {
        self.instead(Instead::Ends)
    }

    /// A cloud that starts the machine and gives it no address.
    pub fn addressless(self) -> Self {
        self.instead(Instead::StaysUnreachable)
    }

    /// A cloud whose machine simply is in this state — for asking what a state
    /// reads as, rather than for waiting on one.
    pub fn sitting_at(self, state: InstanceState) -> Self {
        self.instead(Instead::Sits(state))
    }

    fn instead(self, instead: Instead) -> Self {
        self.script
            .lock()
            .expect("the scripted cloud is single-threaded")
            .instead = instead;
        self
    }

    /// What it was asked, in order.
    pub fn calls(&self) -> Vec<String> {
        self.script
            .lock()
            .expect("the scripted cloud is single-threaded")
            .calls
            .clone()
    }

    /// How many times it was looked at. The number a test asserts when the
    /// claim is about patience — that a doomed machine is not waited out, and
    /// that a slow one is.
    pub fn describes(&self) -> u32 {
        self.script
            .lock()
            .expect("the scripted cloud is single-threaded")
            .describes
    }

    /// Record the call and answer whether this is where it was told to refuse.
    fn asked(&self, stage: Stage, name: &str) -> DriverResult<()> {
        let mut script = self
            .script
            .lock()
            .expect("the scripted cloud is single-threaded");
        script.calls.push(name.to_string());
        match &script.refuse {
            Some((at, code, message)) if *at == stage => Err(DriverError::Refused {
                code: code.clone(),
                message: message.clone(),
            }),
            _ => Ok(()),
        }
    }
}

#[async_trait]
impl CloudDriver for FakeCloud {
    fn substrate(&self) -> &'static str {
        "scripted"
    }

    async fn ensure_network(&self, _plan: &LaunchPlan) -> DriverResult<NetworkRef> {
        self.asked(Stage::Network, "ensure_network")?;
        Ok(NetworkRef("sg-0fake".into()))
    }

    async fn ensure_key(&self, plan: &LaunchPlan) -> DriverResult<KeyPair> {
        self.asked(Stage::Key, "ensure_key")?;
        // The reference is the plan's, not one this file invents: the whole
        // claim being proved upstream is that what the operator configured is
        // what ends up on the machine's record.
        Ok(KeyPair {
            launch_name: plan.key_pair.clone(),
            reference: plan.key_ref.clone(),
        })
    }

    async fn launch(
        &self,
        _plan: &LaunchPlan,
        _network: &NetworkRef,
        _key: &KeyPair,
    ) -> DriverResult<Instance> {
        self.asked(Stage::Launch, "launch")?;
        // Accepted, not ready — which is what every real cloud answers, and the
        // reason the step above has to poll at all.
        Ok(Instance {
            id: InstanceId(Self::INSTANCE.into()),
            state: InstanceState::Starting,
            host: None,
        })
    }

    async fn describe(&self, id: &InstanceId) -> DriverResult<Instance> {
        self.asked(Stage::Describe, "describe")?;
        let mut script = self
            .script
            .lock()
            .expect("the scripted cloud is single-threaded");
        script.describes += 1;
        let looks = script.describes;
        let (state, host) = match script.instead {
            Instead::Ends => (InstanceState::Gone, None),
            Instead::StaysUnreachable => (InstanceState::Running, None),
            Instead::Sits(state) => (state, Some(Self::HOST.to_string())),
            Instead::ComesUp if looks >= script.running_after => {
                (InstanceState::Running, Some(Self::HOST.to_string()))
            }
            Instead::ComesUp => (InstanceState::Starting, None),
        };
        Ok(Instance {
            id: id.clone(),
            state,
            host,
        })
    }

    async fn locate(&self, address: &str) -> DriverResult<Option<InstanceId>> {
        self.asked(Stage::Locate, "locate")?;
        // One address is a machine here and every other address is not, which is
        // the distinction worth scripting: "the account answered and holds no
        // such machine" is a different sentence from "the account refused us",
        // and only one of them is something the customer can fix by typing.
        Ok((address.trim() == Self::HOST).then(|| InstanceId(Self::INSTANCE.into())))
    }

    async fn stop(&self, _id: &InstanceId) -> DriverResult<()> {
        self.asked(Stage::Stop, "stop")?;
        // And it really is stopped afterwards. Recording the call alone would
        // let a test pass that proved only "we asked" — the claim worth proving
        // is that sleep is a state the cloud agrees with, rather than a note
        // this laptop kept about a machine that is still running and billing.
        let mut script = self
            .script
            .lock()
            .expect("the scripted cloud is single-threaded");
        script.instead = Instead::Sits(InstanceState::Stopped);
        Ok(())
    }

    async fn start(&self, id: &InstanceId) -> DriverResult<Instance> {
        self.asked(Stage::Start, "start")?;
        let mut script = self
            .script
            .lock()
            .expect("the scripted cloud is single-threaded");
        // Coming back is the same walk as coming up the first time: accepted at
        // once, addressable a few looks later. The counter goes back to zero so
        // a `running_after` set for this test governs the wake as well as the
        // launch, rather than the wake inheriting a machine that is already up.
        script.instead = Instead::ComesUp;
        script.describes = 0;
        Ok(Instance {
            id: id.clone(),
            state: InstanceState::Starting,
            host: None,
        })
    }

    async fn terminate(&self, _id: &InstanceId) -> DriverResult<()> {
        self.asked(Stage::Terminate, "terminate")?;
        Ok(())
    }
}
