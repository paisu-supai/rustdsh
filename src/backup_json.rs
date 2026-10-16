//! JSON.parse/JSON.stringify boundary for untrusted backup files.
//! RawValue checks even discarded duplicate values without interpreting them.
use serde_json::value::RawValue;
use std::collections::HashMap;

type Result<T> = std::result::Result<T, &'static str>;
pub const FILE_ERROR: &str = "Invalid backup JSON: require a regular UTF-8 file of at most 2 MiB";

#[derive(Clone, Copy, Debug)]
pub struct Json<'a>(pub &'a str);

impl<'a> Json<'a> {
    pub fn parse(text: &'a str) -> Result<Self> {
        serde_json::from_str::<&RawValue>(text)
            .map(|v| Self(v.get()))
            .map_err(|_| FILE_ERROR)
    }

    pub fn null(self) -> bool {
        self.0 == "null"
    }
    pub fn string(self) -> Option<String> {
        (self.0.starts_with('"'))
            .then(|| String::from_utf16(&decode(self.0)).ok())
            .flatten()
    }
    pub fn is(self, text: &str) -> bool {
        self.string().as_deref() == Some(text)
    }
    pub fn number(self) -> Option<f64> {
        if !matches!(self.0.as_bytes().first(), Some(b'-' | b'0'..=b'9')) {
            return None;
        }
        self.0.parse().ok()
    }
    pub fn integer(self) -> Option<u64> {
        let n = self.number()?;
        (n.is_finite() && (0.0..=9007199254740991.0).contains(&n) && n.fract() == 0.0)
            .then_some(n as u64)
    }
    pub fn array(self) -> Option<Vec<Self>> {
        if !self.0.starts_with('[') {
            return None;
        }
        let raw: Vec<&RawValue> = serde_json::from_str(self.0).ok()?;
        Some(raw.into_iter().map(|r| Self(r.get())).collect())
    }
    pub fn object(self) -> Option<Vec<(Vec<u16>, Self)>> {
        if !self.0.starts_with('{') {
            return None;
        }
        let mut pos = 1;
        let mut entries: Vec<(Vec<u16>, Self)> = Vec::new();
        let mut positions = HashMap::new();
        loop {
            ws(self.0, &mut pos);
            if self.0.as_bytes()[pos] == b'}' {
                break;
            }
            let start = pos;
            pos += 1;
            while self.0.as_bytes()[pos] != b'"' {
                if self.0.as_bytes()[pos] == b'\\' {
                    pos += 1;
                }
                pos += 1;
            }
            pos += 1;
            let key = decode(&self.0[start..pos]);
            ws(self.0, &mut pos);
            pos += 1; // colon; the entire document already passed syntax validation
            ws(self.0, &mut pos);
            let mut stream =
                serde_json::Deserializer::from_str(&self.0[pos..]).into_iter::<&RawValue>();
            let raw = stream.next()?.ok()?;
            pos += stream.byte_offset();
            let value = Self(raw.get());
            if let Some(&index) = positions.get(&key) {
                entries[index] = (key, value);
            } else {
                positions.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
            ws(self.0, &mut pos);
            if self.0.as_bytes()[pos] == b'}' {
                break;
            }
            pos += 1;
        }
        Some(entries)
    }
    pub fn get(self, name: &str) -> Self {
        let key: Vec<u16> = name.encode_utf16().collect();
        self.object()
            .and_then(|o| o.into_iter().find(|(k, _)| *k == key).map(|(_, v)| v))
            .unwrap_or(Self("null"))
    }
    pub fn keys(self, allowed: &[&str], required: &[&str]) -> Result<()> {
        let entries = self.object().ok_or("invalid_backup_fields")?;
        let names: Vec<_> = entries
            .iter()
            .map(|(k, _)| String::from_utf16(k).ok())
            .collect();
        if names
            .iter()
            .all(|k| k.as_deref().is_some_and(|k| allowed.contains(&k)))
            && required
                .iter()
                .all(|r| names.iter().any(|k| k.as_deref() == Some(r)))
        {
            Ok(())
        } else {
            Err("invalid_backup_fields")
        }
    }
    pub fn exact(self, allowed: &[&str]) -> Result<()> {
        self.keys(allowed, allowed)
    }

    /// Iterative traversal: unknown depth is not a schema error until validation.
    /// A bounded sink prevents stringify expansion from allocating beyond the limit.
    pub fn stringify(self, canonical: bool, limit: usize) -> Result<String> {
        enum Piece {
            Value(usize),
            Text(String),
            Byte(u8),
        }
        // Descendant RawValue parsing at each depth would be quadratic.
        // Index token/container ends once, then visit retained children only.
        let index = Boundaries::new(self.0);
        let mut pending = vec![Piece::Value(0)];
        let mut out = String::new();
        while let Some(piece) = pending.pop() {
            match piece {
                Piece::Text(s) => out.push_str(&s),
                Piece::Byte(b) => out.push(char::from(b)),
                Piece::Value(start) => {
                    let v = Json(&self.0[start..index.ends[start]]);
                    if v.0.starts_with('{') {
                        let mut entries = index.object(start);
                        if canonical {
                            entries.sort_by(|a, b| a.0.cmp(&b.0));
                        }
                        entries.sort_by_key(|(k, _)| {
                            let n = String::from_utf16(k).ok().and_then(|s| {
                                s.parse::<u32>()
                                    .ok()
                                    .filter(|n| *n != u32::MAX && n.to_string() == s)
                            });
                            (n.is_none(), n.unwrap_or_default())
                        });
                        out.push('{');
                        pending.push(Piece::Byte(b'}'));
                        for (index, (key, value)) in entries.into_iter().enumerate().rev() {
                            pending.push(Piece::Value(value));
                            pending.push(Piece::Byte(b':'));
                            pending.push(Piece::Text(quote(&key)));
                            if index > 0 {
                                pending.push(Piece::Byte(b','));
                            }
                        }
                    } else if v.0.starts_with('[') {
                        let entries = index.array(start);
                        out.push('[');
                        pending.push(Piece::Byte(b']'));
                        for (index, value) in entries.into_iter().enumerate().rev() {
                            pending.push(Piece::Value(value));
                            if index > 0 {
                                pending.push(Piece::Byte(b','));
                            }
                        }
                    } else if v.0.starts_with('"') {
                        out.push_str(&quote(&decode(v.0)));
                    } else if let Some(n) = v.number() {
                        if let Some(n) = serde_json::Number::from_f64(n) {
                            out.push_str(&crate::js_json::stringify(&serde_json::Value::Number(n)));
                        } else {
                            out.push_str("null");
                        }
                    } else {
                        out.push_str(v.0);
                    }
                }
            }
            if out.len() > limit {
                return Err("backup_too_large");
            }
        }
        Ok(out)
    }
}

/// Byte offsets into an already syntax-checked document. Construction and
/// child enumeration never parse a descendant twice, including discarded keys.
struct Boundaries<'a> {
    text: &'a str,
    ends: Vec<usize>,
}
impl<'a> Boundaries<'a> {
    fn new(text: &'a str) -> Self {
        let bytes = text.as_bytes();
        let mut ends = vec![0; bytes.len()];
        let mut containers = Vec::new();
        let mut pos = 0;
        while pos < bytes.len() {
            match bytes[pos] {
                b'{' | b'[' => {
                    containers.push(pos);
                    pos += 1;
                }
                b'}' | b']' => {
                    ends[containers.pop().unwrap()] = pos + 1;
                    pos += 1;
                }
                b'"' => {
                    let start = pos;
                    pos += 1;
                    while bytes[pos] != b'"' {
                        if bytes[pos] == b'\\' {
                            pos += 1;
                        }
                        pos += 1;
                    }
                    pos += 1;
                    ends[start] = pos;
                }
                b',' | b':' | b' ' | b'\r' | b'\n' | b'\t' => pos += 1,
                _ => {
                    let start = pos;
                    while pos < bytes.len()
                        && !matches!(
                            bytes[pos],
                            b',' | b'}' | b']' | b' ' | b'\r' | b'\n' | b'\t'
                        )
                    {
                        pos += 1;
                    }
                    ends[start] = pos;
                }
            }
        }
        Self { text, ends }
    }
    fn array(&self, start: usize) -> Vec<usize> {
        let mut values = Vec::new();
        let mut pos = start + 1;
        loop {
            ws(self.text, &mut pos);
            if self.text.as_bytes()[pos] == b']' {
                break;
            }
            values.push(pos);
            pos = self.ends[pos];
            ws(self.text, &mut pos);
            if self.text.as_bytes()[pos] == b']' {
                break;
            }
            pos += 1;
        }
        values
    }
    fn object(&self, start: usize) -> Vec<(Vec<u16>, usize)> {
        let mut values = Vec::new();
        let mut positions = HashMap::new();
        let mut pos = start + 1;
        loop {
            ws(self.text, &mut pos);
            if self.text.as_bytes()[pos] == b'}' {
                break;
            }
            let end = self.ends[pos];
            let key = decode(&self.text[pos..end]);
            pos = end;
            ws(self.text, &mut pos);
            pos += 1;
            ws(self.text, &mut pos);
            if let Some(&index) = positions.get(&key) {
                values[index] = (key, pos);
            } else {
                positions.insert(key.clone(), values.len());
                values.push((key, pos));
            }
            pos = self.ends[pos];
            ws(self.text, &mut pos);
            if self.text.as_bytes()[pos] == b'}' {
                break;
            }
            pos += 1;
        }
        values
    }
}

fn ws(text: &str, pos: &mut usize) {
    while text
        .as_bytes()
        .get(*pos)
        .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
    {
        *pos += 1;
    }
}

fn decode(raw: &str) -> Vec<u16> {
    let mut units = Vec::new();
    let mut chars = raw[1..raw.len() - 1].chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
            continue;
        }
        let c = chars.next().expect("validated escape");
        if c == 'u' {
            let mut unit = 0;
            for _ in 0..4 {
                unit = unit * 16 + chars.next().unwrap().to_digit(16).unwrap() as u16;
            }
            units.push(unit);
        } else {
            units.push(match c {
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                c => c as u16,
            });
        }
    }
    units
}

fn quote(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for c in char::decode_utf16(units.iter().copied()) {
        match c {
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
            Ok(c) => match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            },
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicates_keep_first_position_and_last_decoded_key_value() {
        let j = Json::parse(r#"{"b":1e309,"a":"\ud800","b":7,"\u0061":"ok"}"#).unwrap();
        assert_eq!(j.stringify(false, 100).unwrap(), r#"{"b":7,"a":"ok"}"#);
        assert!(Json::parse(r#"{"a":[1,],"a":0}"#).is_err());
    }
    #[test]
    fn invalid_values_survive_until_schema_and_size_checks() {
        let j = Json::parse(r#"{"x":"\ud800","n":1e309}"#).unwrap();
        assert_eq!(
            j.stringify(false, 100).unwrap(),
            r#"{"x":"\ud800","n":null}"#
        );
        for n in [128, 129, 1024] {
            let text = format!("{{\"x\":{}0{}}}", "[".repeat(n), "]".repeat(n));
            let j = Json::parse(&text).unwrap();
            assert_eq!(j.stringify(false, 10000).unwrap(), text);
        }
        assert_eq!(Json("1.00000000000000001").integer(), Some(1));
        assert_eq!(Json("1e-400").integer(), Some(0));
    }
}
