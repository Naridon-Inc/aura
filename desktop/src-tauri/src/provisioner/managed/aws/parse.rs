//! Reading EC2's answers.
//!
//! The EC2 Query API answers in XML, and this reads the six or seven elements
//! we actually use out of it. Not a parser — a scanner: find an element by
//! name, hand back what is between its tags, and count depth so a nested
//! element of the same name (`<item>` inside `<item>`, which is exactly how a
//! reservation holds its instances) closes the right one.
//!
//! That is a deliberate choice over pulling an XML crate. The whole surface
//! here is five requests whose response shapes are fixed and versioned by AWS,
//! and every element we read is a leaf holding a short flat string. A general
//! parser would bring namespaces, entities, DTDs and a dependency, to answer
//! questions this can answer in fifty lines that a person can hold in their
//! head — and the correctness that matters is pinned by the tests below,
//! against real response shapes.
//!
//! What it is NOT is a general reader, and it does not pretend to be. It does
//! not do comments, CDATA or processing instructions, because EC2's responses
//! contain none, and a caller that fed it a document with them would get an
//! honest `None` rather than a wrong answer.

/// The text inside the first `<tag>…</tag>`, entities decoded and trimmed.
///
/// `None` when the element is absent — which for most of these fields is a real
/// answer rather than a malformed document. An instance still starting has no
/// address element at all, and that is precisely how the step above knows to
/// keep waiting.
pub fn text(xml: &str, tag: &str) -> Option<String> {
    let inner = element(xml, tag)?;
    let value = unescape(inner);
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// The raw contents of the first `<tag>…</tag>`, tags and all.
///
/// Kept separate from [`text`] because the useful move on this shape is to
/// narrow: take the `<instanceState>` element, THEN read its `<name>` — since
/// `name` on its own appears in half a dozen unrelated places in one response.
pub fn element<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut from = 0usize;

    // Find an opening tag that is really this tag, and not one whose name
    // merely starts the same way — `<instanceId>` must not match
    // `<instanceIdSet>`.
    let (body_start, self_closing) = loop {
        let at = xml.get(from..)?.find(&open)? + from;
        let after = at + open.len();
        match xml.as_bytes().get(after) {
            Some(b'>') => break (after + 1, false),
            // `<tag/>` — present and empty, which is a different answer from
            // absent and worth keeping distinct.
            Some(b'/') if xml.as_bytes().get(after + 1) == Some(&b'>') => break (after + 2, true),
            // Attributes. The root element of every response carries `xmlns`.
            Some(c) if c.is_ascii_whitespace() => {
                let gt = xml.get(after..)?.find('>')? + after;
                let empty = xml.as_bytes()[gt - 1] == b'/';
                break (gt + 1, empty);
            }
            // A longer name that happens to start with ours. Keep looking.
            Some(_) => from = after,
            None => return None,
        }
    };
    if self_closing {
        return Some("");
    }

    // Walk to the close that belongs to THIS open, counting same-named opens on
    // the way. Without the count, `<reservationSet><item><instancesSet><item>`
    // hands back everything up to the inner `</item>` — a truncated document
    // that parses fine and is missing the fields we came for.
    let mut depth = 1usize;
    let mut at = body_start;
    while at < xml.len() {
        let next_open = xml.get(at..).and_then(|s| s.find(&open)).map(|o| o + at);
        let next_close = xml.get(at..).and_then(|s| s.find(&close)).map(|o| o + at)?;
        match next_open {
            Some(o) if o < next_close && opens_here(xml, o + open.len()) => {
                depth += 1;
                at = o + open.len();
            }
            // A same-prefixed longer name before the close is not a nesting.
            Some(o) if o < next_close => at = o + open.len(),
            _ => {
                depth -= 1;
                if depth == 0 {
                    return Some(&xml[body_start..next_close]);
                }
                at = next_close + close.len();
            }
        }
    }
    None
}

/// Whether the byte after `<tag` really ends the tag name.
fn opens_here(xml: &str, after: usize) -> bool {
    matches!(xml.as_bytes().get(after), Some(b'>') | Some(b'/'))
        || xml
            .as_bytes()
            .get(after)
            .is_some_and(|c| c.is_ascii_whitespace())
}

/// The five entities XML defines. EC2 escapes `&` in error messages and
/// nothing else, but decoding all five costs nothing and a message rendered
/// with a literal `&amp;` in it looks like a bug in Aura.
fn unescape(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        // Last, or `&amp;lt;` would come out as `<` rather than as `&lt;`.
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `DescribeInstances` actually answers with, trimmed to the
    /// elements this module reads. The nesting is the point: `item` inside
    /// `item`, which is what a naive first-close scanner gets wrong.
    const DESCRIBE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>1234</requestId>
  <reservationSet>
    <item>
      <reservationId>r-01</reservationId>
      <instancesSet>
        <item>
          <instanceId>i-0abc123</instanceId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <dnsName>ec2-198-51-100-7.compute.amazonaws.com</dnsName>
          <ipAddress>198.51.100.7</ipAddress>
          <placement><availabilityZone>eu-central-1a</availabilityZone></placement>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>"#;

    #[test]
    fn an_item_inside_an_item_closes_the_right_one() {
        // The failure this whole scanner is arranged against. Closed at the
        // first `</item>`, the reservation's contents stop before the instance
        // ever appears — and the caller reports "the cloud answered in a shape
        // we don't understand" about a perfectly ordinary response.
        let reservations = element(DESCRIBE, "reservationSet").expect("reservations");
        let reservation = element(reservations, "item").expect("a reservation");
        assert!(reservation.contains("i-0abc123"), "the reservation was truncated");
        let instances = element(reservation, "instancesSet").expect("instances");
        let instance = element(instances, "item").expect("an instance");
        assert_eq!(text(instance, "instanceId").as_deref(), Some("i-0abc123"));
    }

    #[test]
    fn a_state_is_read_from_its_own_element_and_not_from_the_first_name_anywhere() {
        // `name` appears in several unrelated places in one response. Read from
        // the document root it is a coin flip; read from `instanceState` it is
        // the answer.
        let state = element(DESCRIBE, "instanceState").expect("a state");
        assert_eq!(text(state, "name").as_deref(), Some("running"));
    }

    #[test]
    fn a_longer_tag_that_starts_the_same_way_is_not_this_tag() {
        // `<instanceId>` and `<instanceIdSet>` differ by three characters, and
        // matching the wrong one hands back a list where an id belongs.
        let xml = "<a><instanceIdSet><item>i-1</item></instanceIdSet><instanceId>i-2</instanceId></a>";
        assert_eq!(text(xml, "instanceId").as_deref(), Some("i-2"));
    }

    #[test]
    fn an_element_that_is_not_there_is_not_an_error() {
        // An instance that is still starting has no address element at all,
        // which is exactly how the step above knows to keep waiting. Answering
        // that with a failure would turn every ordinary launch into one.
        let starting = "<item><instanceId>i-1</instanceId><instanceState><code>0</code><name>pending</name></instanceState></item>";
        assert_eq!(text(starting, "dnsName"), None);
        assert_eq!(text(starting, "ipAddress"), None);
        assert_eq!(text(starting, "instanceId").as_deref(), Some("i-1"));
    }

    #[test]
    fn an_element_present_and_empty_is_not_an_element_missing() {
        // EC2 sends `<dnsName/>` for an instance in a network that hands out no
        // public name. `text` folds it to `None` — there is nothing to dial —
        // but `element` still reports it was there, which is what keeps the
        // scanner honest about the two cases.
        assert_eq!(element("<a><dnsName/></a>", "dnsName"), Some(""));
        assert_eq!(text("<a><dnsName/></a>", "dnsName"), None);
        assert_eq!(text("<a><dnsName></dnsName></a>", "dnsName"), None);
        assert_eq!(text("<a><dnsName>  </dnsName></a>", "dnsName"), None);
    }

    #[test]
    fn the_root_elements_attributes_do_not_hide_it() {
        // Every real response's root carries an `xmlns`, so a scanner that only
        // accepted `<tag>` would fail on the first byte of every answer.
        let inner = element(DESCRIBE, "DescribeInstancesResponse").expect("the root");
        assert!(inner.contains("reservationSet"));
    }

    #[test]
    fn an_unclosed_document_is_no_answer_rather_than_a_wrong_one() {
        // A truncated response is a network that dropped, and guessing at what
        // the rest said is how a half-made machine gets reported as made.
        assert_eq!(element("<a><b>oops", "b"), None);
        assert_eq!(element("nothing here", "b"), None);
    }

    #[test]
    fn an_escaped_message_reads_as_a_sentence() {
        // The message is shown to a person. A literal `&amp;` in it looks like
        // a bug in Aura rather than a quirk of the cloud's XML.
        let xml = "<Message>Group &quot;a &amp; b&quot; not found</Message>";
        assert_eq!(
            text(xml, "Message").as_deref(),
            Some(r#"Group "a & b" not found"#)
        );
        // Ampersand last, or an escaped escape decodes twice.
        assert_eq!(unescape("&amp;lt;"), "&lt;");
    }
}
