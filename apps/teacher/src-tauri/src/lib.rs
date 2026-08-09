use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct RuntimeInfo {
    pub app_name: &'static str,
    pub phase: &'static str,
}

#[tauri::command]
fn get_app_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_name: "Classroom",
        phase: "Phase 1",
    }
}

pub fn run() -> Result<(), String> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_app_runtime_info])
        .run(tauri::generate_context!())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::RuntimeInfo;

    #[test]
    fn runtime_info_has_the_phase_marker() {
        let info = RuntimeInfo {
            app_name: "Classroom",
            phase: "Phase 1",
        };

        assert_eq!(info.app_name, "Classroom");
        assert_eq!(info.phase, "Phase 1");
    }
}
