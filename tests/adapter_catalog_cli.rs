//! Node-free catalog checks on the real binary and its native `dsh` alias.
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-adapter-catalog-{suffix}"));
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(root.join("home/.dsh")).unwrap();
        fs::write(root.join("home/.dsh/rdsh.json"), "broken settings").unwrap();
        Self(root)
    }

    fn run(&self, executable: &Path, language: &str) -> Output {
        let mut command = Command::new(executable);
        command.env_clear();
        for key in ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .arg("adapter-catalog")
            .current_dir(&self.0)
            .env("HOME", self.0.join("home"))
            .env("USERPROFILE", self.0.join("home"))
            .env("APPDATA", self.0.join("appdata"))
            .env("LOCALAPPDATA", self.0.join("localappdata"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("DSH_HOME", self.0.join("home/.dsh"))
            .env("PATH", "")
            .env("RDSH_AUTH_AUTOSYNC", "0")
            .env("RDSH_DRY_RUN", "1")
            .env("RDSH_ORIG_BIN", self.0.join("missing-original-dsh"))
            // Keep adapter-catalog first: native dsh alias routing checks argv[1].
            .env("RDSH_LANG", language)
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn catalog_is_native_settings_independent_and_identical_for_both_names_and_all_locales() {
    let fixture = Fixture::new();
    let binary = Path::new(env!("CARGO_BIN_EXE_rdsh"));
    let alias = fixture
        .0
        .join(if cfg!(windows) { "dsh.exe" } else { "dsh" });
    fs::copy(binary, &alias).unwrap();
    assert!(!fixture.0.join("missing-original-dsh").exists());
    let mut expected: Option<Vec<u8>> = None;
    for executable in [binary, alias.as_path()] {
        for language in ["en", "ja", "zh-CN"] {
            let output = fixture.run(executable, language);
            assert!(
                output.status.success(),
                "{} {language}: {}",
                executable.display(),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(output.stderr.is_empty(), "{:?}", output.stderr);
            let document: Value = serde_json::from_slice(&output.stdout).unwrap();
            let adapters = document["adapters"].as_array().unwrap();
            assert_eq!(adapters.len(), 4);
            let ids: Vec<_> = adapters
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, ["dsh", "codex", "claude", "kimi"]);
            for adapter in adapters {
                let operations = adapter["operations"].as_object().unwrap();
                let names: Vec<_> = operations.keys().map(String::as_str).collect();
                assert_eq!(
                    names,
                    ["start", "resume", "send", "interrupt", "stop", "usage"]
                );
            }
            let pretty = serde_json::to_string_pretty(&document).unwrap() + "\n";
            assert_eq!(output.stdout, pretty.as_bytes());
            assert!(!output.stdout.contains(&b'\r'));
            if let Some(expected) = &expected {
                assert_eq!(&output.stdout, expected);
            } else {
                expected = Some(output.stdout);
            }
        }
    }
}
