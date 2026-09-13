# Windows 發佈與安裝

## 發佈方式

支援 Windows 10 / 11 x64（`x86_64-pc-windows-msvc`），僅提供 NSIS `*-setup.exe`，以 current-user 模式安裝，正常情況不需要 Administrator。此版本為未簽章的內部直接分發版本；Unknown publisher / SmartScreen 提示屬於 **KNOWN_DISTRIBUTION_LIMITATION**。請先向提供者確認檔案來源與 SHA256。

WebView2 採 Tauri 預設 `downloadBootstrapper`：缺少 runtime 時下載安裝，因此可能需要 Internet。本版不提供離線 runtime、MSI、portable、updater 或自動更新。

## 建置與資源

在 repository root 執行：

```powershell
pnpm tauri:build --target x86_64-pc-windows-msvc --bundles nsis
```

Tauri 的 `beforeBuildCommand` 執行 Teacher 的 `build:tauri-frontend`，先建置 Student，再建置 Teacher。Teacher 使用 `../dist`；Student 的 `../../student/dist` 打包到 resource directory 的 `student`。Release runtime 從該資源目錄讀取 Student 頁面，不需要 source checkout、Node、pnpm 或 dev server。

安裝檔位於 `apps/teacher/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。請分發 setup EXE；release 目錄中的程式 EXE 不是 portable 發佈套件。建置產物保持在 Git 忽略的 target 目錄。

## 首次啟動與本機資料

首次啟動使用 Tauri `app_data_dir`，在 Windows 為目前使用者的 `%APPDATA%/com.classtools.teacher`。資料庫為 `classroom.sqlite3`，管理的媒體位於 `assets`；程式沿用既有 migrations 初始化及驗證資料庫，不需要向安裝目錄寫入資料。

產品名稱 `Classroom Teacher`、identifier `com.classtools.teacher` 與版本 `0.1.0` 維持不變。重啟時既有非終止 Session 會結束為 ENDED，保留歷史資料，不恢復進行中的課堂。正常離開會結束活躍 Session 並停止本機 server。

解除安裝不是備份。本階段尚未實測解除安裝後的資料保留／刪除行為，因此不承諾任一結果；本版沒有 backup / restore UI。不要為了驗證首次啟動而刪除真實資料庫。

## 區域網路與 Firewall

1. 教師與學生裝置連接同一個可信任 LAN，Windows 網路設定使用 Private profile。
2. 在 Teacher 啟動本機 server，選取學生可連到的 LAN URL，再以 QR code 開啟 Student 頁面並加入課堂。
3. 第一次啟動 server 時 Windows 可能詢問 Firewall 權限；允許可信任的 Private network。不要為了測試自動放行 Public network。程式不會自動修改 Firewall 規則。

無法連線時，依序確認 server 已啟動、所選 IP / URL 正確、兩台裝置在同一網路、Private profile 與 Firewall 放行設定，再檢查 AP/client isolation。Guest Wi-Fi、VLAN 或校園網路隔離可能阻止裝置互連；不保證跨子網、NAT 或 Internet 連線。

## 安裝後人工驗證

- 以一般使用者安裝並啟動，確認沒有 WebView2 或 Student 資源錯誤。
- 確認既有／新增本機資料可讀寫，關閉重開後仍可使用。
- 使用同 LAN 的另一台裝置掃 QR code，確認 Student 頁面與加入課堂；方便時檢查 authenticated media。
- 全新資料初始化可用 Windows Sandbox 或拋棄式 Windows 使用者驗證；不方便時延至 Phase 15，勿刪除正式資料。

本文件描述建置與操作方式；實際安裝、執行與解除安裝結果仍需 Human QA。
