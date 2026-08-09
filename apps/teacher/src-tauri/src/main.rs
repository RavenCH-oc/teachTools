fn main() {
    if let Err(error) = teacher_lib::run() {
        eprintln!("Classroom Teacher failed to start: {}", error);
        std::process::exit(1);
    }
}
