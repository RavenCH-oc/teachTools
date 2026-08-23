import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { QuestionAsset, QuestionAssetPreview } from "@classtools/domain";
import type { DraftQuestionAsset, TeacherApi } from "../../../types/teacher";
import { TeacherApiError } from "../../../services/teacherApi";

interface Props {
  api: TeacherApi;
  questionId: string | null;
  assets: QuestionAsset[];
  onChange: Dispatch<SetStateAction<QuestionAsset[]>>;
  onError: (message: string) => void;
}

export function QuestionAssetEditor({ api, questionId, assets, onChange, onError }: Props) {
  const [importing, setImporting] = useState<"image" | "pdf" | null>(null);
  const importAsset = async (kind: "image" | "pdf") => {
    if (!questionId) return;
    setImporting(kind);
    try {
      const sourcePath = await open({
        multiple: false,
        title: kind === "image" ? "加入題目圖片" : "加入題目 PDF",
        filters: kind === "image" ? [{ name: "圖片", extensions: ["png", "jpg", "jpeg", "webp"] }] : [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof sourcePath !== "string") return;
      const asset = await api.importQuestionAsset(questionId, sourcePath);
      onChange((current) => [...current, asset].sort((left, right) => left.position - right.position));
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "無法加入所選檔案。");
    } finally {
      setImporting(null);
    }
  };
  const remove = async (asset: QuestionAsset) => {
    if (!window.confirm(`確定要從此題移除「${asset.displayName}」嗎？此操作只會刪除管理中的副本。`)) return;
    try {
      await api.deleteQuestionAsset(asset.id);
      onChange((current) => current.filter((item) => item.id !== asset.id));
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "無法移除附件。");
    }
  };
  const updatePageReference = async (asset: QuestionAsset, value: string) => {
    const pageReference = value.trim() ? Number(value) : null;
    if (pageReference !== null && (!Number.isInteger(pageReference) || pageReference < 1)) {
      onError("PDF 頁碼必須是正整數。");
      return;
    }
    try {
      const updated = await api.updateQuestionAssetPageReference(asset.id, pageReference);
      onChange((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "無法儲存 PDF 頁碼。");
    }
  };
  const disabled = !questionId || importing !== null;
  return <section className="asset-editor" aria-label="題目附件">
    <div className="asset-heading"><span>附件</span><small>{questionId ? "最多可加入 10 個圖片或 PDF。" : "儲存題目後即可加入圖片或 PDF。"}</small></div>
    {questionId && <p className="asset-note">選取檔案會複製到 Classroom 管理的儲存空間，原始檔不會被移動。</p>}
    <div className="asset-import-actions">
      <button className="button ghost" disabled={disabled} onClick={() => void importAsset("image")} type="button">{importing === "image" ? "正在加入圖片…" : "加入圖片"}</button>
      <button className="button ghost" disabled={disabled} onClick={() => void importAsset("pdf")} type="button">{importing === "pdf" ? "正在加入 PDF…" : "加入 PDF"}</button>
    </div>
    {assets.length === 0 ? questionId && <p className="asset-empty">尚未加入附件。</p> : <ul className="asset-list">{assets.map((asset) => <AssetRow key={asset.id} api={api} asset={asset} onRemove={() => void remove(asset)} onPageReference={updatePageReference} />)}</ul>}
  </section>;
}

interface DraftProps {
  api: TeacherApi;
  draftId: string | null;
  assets: DraftQuestionAsset[];
  onChange: Dispatch<SetStateAction<DraftQuestionAsset[]>>;
  onError: (message: string) => void;
}

export function DraftQuestionAssetEditor({ api, draftId, assets, onChange, onError }: DraftProps) {
  const [importing, setImporting] = useState<"image" | "pdf" | null>(null);
  const importAsset = async (kind: "image" | "pdf") => {
    if (!draftId) return;
    setImporting(kind);
    try {
      const sourcePath = await open({
        multiple: false,
        title: kind === "image" ? "加入題目圖片" : "加入題目 PDF",
        filters: kind === "image" ? [{ name: "圖片", extensions: ["png", "jpg", "jpeg", "webp"] }] : [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof sourcePath !== "string") return;
      const asset = await api.importQuestionDraftAsset(draftId, sourcePath);
      onChange((current) => [...current, asset]);
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "無法加入所選檔案。");
    } finally {
      setImporting(null);
    }
  };
  const remove = async (asset: DraftQuestionAsset) => {
    if (!draftId || !window.confirm(`確定要從此草稿移除「${asset.displayName}」嗎？`)) return;
    try {
      await api.deleteQuestionDraftAsset(draftId, asset.id);
      onChange((current) => current.filter((item) => item.id !== asset.id));
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "無法移除草稿附件。");
    }
  };
  const disabled = !draftId || importing !== null || assets.length >= 10;
  return <section className="asset-editor" aria-label="題目附件">
    <div className="asset-heading"><span>附件</span><small>最多可加入 10 個圖片或 PDF。</small></div>
    <p className="asset-note">選取檔案會複製到 Classroom 管理的暫存空間，原始檔不會被移動。</p>
    <div className="asset-import-actions">
      <button className="button ghost" disabled={disabled} onClick={() => void importAsset("image")} type="button">{importing === "image" ? "正在加入圖片…" : "加入圖片"}</button>
      <button className="button ghost" disabled={disabled} onClick={() => void importAsset("pdf")} type="button">{importing === "pdf" ? "正在加入 PDF…" : "加入 PDF"}</button>
    </div>
    {!draftId ? <p className="asset-empty">正在準備題目草稿…</p> : assets.length === 0 ? <p className="asset-empty">尚未加入附件。</p> : <ul className="asset-list">{assets.map((asset) => <DraftAssetRow asset={asset} key={asset.id} onRemove={() => void remove(asset)} />)}</ul>}
  </section>;
}

function AssetRow({ api, asset, onRemove, onPageReference }: { api: TeacherApi; asset: QuestionAsset; onRemove: () => void; onPageReference: (asset: QuestionAsset, value: string) => Promise<void> }) {
  const [preview, setPreview] = useState<QuestionAssetPreview | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "missing" | "corrupted">(asset.status === "missing" ? "missing" : "loading");
  const [pageValue, setPageValue] = useState(asset.pageReference?.toString() ?? "");
  useEffect(() => { setPageValue(asset.pageReference?.toString() ?? ""); }, [asset.id, asset.pageReference]);
  useEffect(() => {
    let active = true;
    if (asset.status === "missing") { setPreviewState("missing"); return () => { active = false; }; }
    setPreviewState("loading");
    void api.getQuestionAssetPreview(asset.id)
      .then((next) => { if (active) { setPreview(next); setPreviewState("ready"); } })
      .catch((cause: unknown) => {
        if (!active) return;
        setPreviewState(cause instanceof TeacherApiError && cause.code === "asset_corrupted" ? "corrupted" : "missing");
      });
    return () => { active = false; };
  }, [api, asset.id, asset.status]);
  return <li className="asset-row">
    <div className="asset-visual">{asset.assetType === "image" && previewState === "ready" && preview ? <img alt={asset.displayName} src={preview.assetUrl} /> : <span>{asset.assetType === "pdf" ? "PDF" : "圖片"}</span>}</div>
    <div className="asset-details"><strong>{asset.displayName}</strong><small>{asset.assetType === "pdf" ? "PDF" : asset.mimeType} · {formatBytes(asset.sizeBytes)}</small>{previewState === "missing" && <p className="asset-warning">附件檔案無法使用，請移除後重新加入。</p>}{previewState === "corrupted" && <p className="asset-warning">附件檔案可能已損毀或遭到變更，請移除後重新加入。</p>}{asset.assetType === "pdf" && <label className="asset-page">頁碼 <input aria-label={`${asset.displayName} 的頁碼`} min={1} onBlur={() => void onPageReference(asset, pageValue)} onChange={(event) => setPageValue(event.target.value)} placeholder="選填" type="number" value={pageValue} />{previewState === "ready" && preview && <a href={preview.assetUrl} rel="noreferrer" target="_blank">開啟 PDF</a>}</label>}</div>
    <button aria-label={`刪除 ${asset.displayName}`} className="text-button danger" onClick={onRemove} type="button">刪除</button>
  </li>;
}

function DraftAssetRow({ asset, onRemove }: { asset: DraftQuestionAsset; onRemove: () => void }) {
  return <li className="asset-row">
    <div className="asset-visual">{asset.assetType === "image" ? <img alt={asset.displayName} src={asset.assetUrl} /> : <span>PDF</span>}</div>
    <div className="asset-details"><strong>{asset.displayName}</strong><small>{asset.assetType === "pdf" ? "PDF" : asset.mimeType} · {formatBytes(asset.sizeBytes)}</small>{asset.assetType === "pdf" && <a href={asset.assetUrl} rel="noreferrer" target="_blank">開啟 PDF</a>}</div>
    <button aria-label={`刪除 ${asset.displayName}`} className="text-button danger" onClick={onRemove} type="button">刪除</button>
  </li>;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
