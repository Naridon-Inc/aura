//! Incremental SSE framing over bytes. UTF-8 is decoded only after a full line,
//! preserving characters split across network chunks. CRLF and EOF are legal.
#[derive(Default)]
pub(super) struct SseDecoder {
    pending: Vec<u8>,
    data: Vec<String>,
}
impl SseDecoder {
    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > 8 * 1024 * 1024 {
            return Err("Response frame exceeded 8 MB".into());
        }
        let mut out = vec![];
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line = self.pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "Response contains invalid UTF-8")?
                .trim_end_matches(['\r', '\n']);
            self.line(line, &mut out);
        }
        Ok(out)
    }
    fn line(&mut self, line: &str, out: &mut Vec<String>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                out.push(self.data.join("\n"));
                self.data.clear();
            }
        } else if let Some(data) = line.strip_prefix("data:") {
            self.data
                .push(data.strip_prefix(' ').unwrap_or(data).into());
        }
    }
    pub(super) fn finish(&mut self) -> Result<Vec<String>, String> {
        let tail = std::mem::take(&mut self.pending);
        let line = std::str::from_utf8(&tail)
            .map_err(|_| "Response ended in an incomplete UTF-8 character")?
            .trim_end_matches('\r');
        let mut out = vec![];
        if !line.is_empty() {
            self.line(line, &mut out);
        }
        self.line("", &mut out);
        Ok(out)
    }
}

#[cfg(test)]
mod chat_coverage_tests {
    use super::*;
    #[test]
    fn every_byte_boundary_preserves_unicode_and_crlf() {
        let wire = "data: {\"text\":\"Hi 👋 世界\"}\r\n\r\ndata: [DONE]\r\n\r\n".as_bytes();
        for split in 0..=wire.len() {
            let mut d = SseDecoder::default();
            let mut out = d.push(&wire[..split]).unwrap();
            out.extend(d.push(&wire[split..]).unwrap());
            out.extend(d.finish().unwrap());
            assert_eq!(out, vec!["{\"text\":\"Hi 👋 世界\"}", "[DONE]"]);
        }
    }
    #[test]
    fn multiline_comments_and_unterminated_final_frame() {
        let mut d = SseDecoder::default();
        assert!(d
            .push(b": keepalive\n\ndata: one\ndata: two")
            .unwrap()
            .is_empty());
        assert_eq!(d.finish().unwrap(), vec!["one\ntwo"]);
    }
    #[test]
    fn rejects_partial_utf8_at_eof() {
        let mut d = SseDecoder::default();
        d.push(b"data: \xf0\x9f").unwrap();
        assert!(d.finish().is_err());
    }
}
