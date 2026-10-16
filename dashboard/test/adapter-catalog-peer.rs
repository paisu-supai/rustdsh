use std::{env, fs, fs::OpenOptions, io::Write, path::Path, thread, time::Duration};

fn mark(stage: &str, argv0: &str) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(env::var_os("RDSH_CATALOG_PEER_MARKER").unwrap())
        .unwrap();
    writeln!(
        file,
        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        stage,
        std::process::id(),
        argv0,
        env::var("DSH_HOME").unwrap(),
        env::var("RDSH_LANG").unwrap_or_default(),
        env::var("NO_COLOR").unwrap_or_default(),
        env::var("CLICOLOR_FORCE").unwrap_or_default(),
        env::var("FORCE_COLOR").unwrap_or_default()
    )
    .unwrap();
}
fn hang() -> ! {
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}
fn main() {
    let args: Vec<_> = env::args().collect();
    if args[1..] == ["--hold-pipe"] {
        thread::sleep(Duration::from_secs(35));
        return;
    }
    if Path::new(&args[0]).file_name().unwrap() != "rdsh" {
        mark("delegated", &args[0]);
        println!("SDK dry-run must never be accepted");
        return;
    }
    let mode = env::var("RDSH_CATALOG_PEER_MODE").unwrap();
    if args[1..] == ["--language=en", "--help"] {
        mark("help", &args[0]);
        match mode.as_str() {
            "hang-help" => hang(),
            "deadline" => thread::sleep(Duration::from_secs(5)),
            "pipe-child" => {
                let _child = std::process::Command::new(env::current_exe().unwrap())
                    .arg("--hold-pipe")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::inherit())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                    .unwrap();
            }
            "help-exit" => std::process::exit(7),
            "help-signal" => terminate(),
            "help-stderr" => eprintln!("unexpected help diagnostic"),
            "overflow" => {
                // Each stream fits individually; only their combined byte count exceeds 64 KiB.
                std::io::stdout().write_all(&vec![b'x'; 32768]).unwrap();
                std::io::stderr().write_all(&vec![b'y'; 32769]).unwrap();
                hang();
            }
            "dirty-home" => fs::write(
                Path::new(&env::var_os("DSH_HOME").unwrap()).join("unexpected"),
                "keep me",
            )
            .unwrap(),
            _ => (),
        }
        println!("Rust launcher\n\nCommands:\n  doctor  Diagnose installation");
        match mode.as_str() {
            "legacy" | "after-help" | "second-commands" => (),
            "wrapped-description" => {
                println!("      adapter-catalog is only a doctor description continuation")
            }
            "suffix" => println!("  adapter-catalogue  Not the required command"),
            "color" => println!("  \x1b[32madapter-catalog\x1b[0m  Catalog"),
            _ => println!("  adapter-catalog  Catalog"),
        }
        println!(
            "\nOptions:\n  --help  Print help\n\nNotes: adapter-catalog is only a mention here."
        );
        if mode == "after-help" {
            println!("  adapter-catalog  Fake entry outside Commands");
        }
        if mode == "second-commands" {
            println!("Commands:\n  adapter-catalog  Fake entry in a second Commands section");
        }
        return;
    }
    mark("operation", &args[0]);
    assert_eq!(args[1..], ["adapter-catalog"]);
    match mode.as_str() {
        "exit7" => std::process::exit(7),
        "op-signal" => terminate(),
        "deadline" => hang(),
        _ => println!("peer-catalog"),
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
