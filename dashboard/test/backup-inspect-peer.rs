use std::{
    env,
    fs::OpenOptions,
    io::{self, Write},
    path::Path,
    thread,
    time::Duration,
};
fn mark(text: &str) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(env::var_os("RDSH_INSPECT_PEER_MARKER").unwrap())
        .unwrap();
    writeln!(file, "{text}").unwrap();
}
fn main() {
    let args: Vec<_> = env::args().collect();
    if Path::new(&args[0]).file_name().unwrap() != "rdsh" {
        mark("delegated-from-dsh-argv0");
        println!("SDK/profile boot dry-run");
        return;
    }
    let mode = env::var("RDSH_INSPECT_PEER_MODE").unwrap_or_default();
    if args[1..] == ["--language=en", "--help"] {
        if mode == "timeout" {
            thread::sleep(Duration::from_secs(5));
        }
        if mode == "bad-exit" {
            std::process::exit(7);
        }
        if mode == "bad-stderr" {
            eprintln!("unexpected help diagnostic");
        }
        if mode == "overflow" {
            io::stdout().write_all(&vec![b'x'; 65537]).unwrap();
            return;
        }
        if mode == "dirty-home" {
            let home = env::var("DSH_HOME").unwrap();
            std::fs::write(Path::new(&home).join("unexpected"), b"preserve").unwrap();
            std::fs::write(env::var_os("RDSH_INSPECT_PEER_HOME_RECORD").unwrap(), home).unwrap();
        }
        println!("Rust launcher\n\nCommands:\n  doctor  Diagnose installation");
        if mode != "legacy" {
            println!("  backup-inspect  Inspect a backup");
        }
        println!("\nOptions:\n  --help  Print help\n\nNotes: backup-inspect is mentioned here but is not a command qualification.");
        if mode == "help-signal" {
            terminate();
        }
        return;
    }
    mark(&format!("operation:{}", args[1..].join(" ")));
    assert_eq!(args[1], "backup-inspect");
    match mode.as_str() {
        "exit7" => std::process::exit(7),
        "signal" => terminate(),
        "timeout" => loop {
            thread::sleep(Duration::from_secs(1));
        },
        _ => panic!("operation must not be reached in a rejected-help test"),
    }
}
#[cfg(unix)]
fn terminate() {
    unsafe extern "C" {
        fn raise(signal: i32) -> i32;
    }
    unsafe {
        raise(15);
    }
    std::process::exit(99);
}
#[cfg(windows)]
fn terminate() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn TerminateProcess(process: *mut std::ffi::c_void, code: u32) -> i32;
    }
    unsafe {
        TerminateProcess(GetCurrentProcess(), 1);
    }
    std::process::exit(99);
}
