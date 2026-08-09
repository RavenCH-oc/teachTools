import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { QuestionAsset, QuestionAssetPreview } from "@classtools/domain";
import type { TeacherApi } from "../../../types/teacher";
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
        title: kind === "image" ? "Import question image" : "Import question PDF",
        filters: kind === "image" ? [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] : [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof sourcePath !== "string") return;
      const asset = await api.importQuestionAsset(questionId, sourcePath);
      onChange((current) => [...current, asset].sort((left, right) => left.position - right.position));
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "Could not import the selected file.");
    } finally {
      setImporting(null);
    }
  };
  const remove = async (asset: QuestionAsset) => {
    if (!window.confirm(`Remove ${asset.displayName} from this question? This removes the managed copy only.`)) return;
    try {
      await api.deleteQuestionAsset(asset.id);
      onChange((current) => current.filter((item) => item.id !== asset.id));
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "Could not remove the attachment.");
    }
  };
  const updatePageReference = async (asset: QuestionAsset, value: string) => {
    const pageReference = value.trim() ? Number(value) : null;
    if (pageReference !== null && (!Number.isInteger(pageReference) || pageReference < 1)) {
      onError("PDF page references must be positive whole numbers.");
      return;
    }
    try {
      const updated = await api.updateQuestionAssetPageReference(asset.id, pageReference);
      onChange((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      onError(cause instanceof TeacherApiError ? cause.message : "Could not save the PDF page reference.");
    }
  };
  const disabled = !questionId || importing !== null;
  return <section className="asset-editor" aria-label="Question media">
    <div className="editor-subheading"><div><span>Images / PDF</span><small>Up to 10 managed files per saved question.</small></div></div>
    <p className="asset-note">{questionId ? "Files are copied into Classroom storage; the original file is never moved." : "Save this question before importing media."}</p>
    <div className="asset-import-actions">
      <button className="button ghost" disabled={disabled} onClick={() => void importAsset("image")} type="button">{importing === "image" ? "Importing image…" : "Import image"}</button>
      <button className="button ghost" disabled={disabled} onClick={() => void importAsset("pdf")} type="button">{importing === "pdf" ? "Importing PDF…" : "Import PDF"}</button>
    </div>
    {assets.length === 0 ? <p className="asset-empty">No images or PDFs attached.</p> : <ul className="asset-list">{assets.map((asset) => <AssetRow key={asset.id} api={api} asset={asset} onRemove={() => void remove(asset)} onPageReference={updatePageReference} />)}</ul>}
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
    <div className="asset-visual">{asset.assetType === "image" && previewState === "ready" && preview ? <img alt={asset.displayName} src={preview.assetUrl} /> : <span>{asset.assetType === "pdf" ? "PDF" : "Image"}</span>}</div>
    <div className="asset-details"><strong>{asset.displayName}</strong><small>{asset.assetType === "pdf" ? "PDF" : asset.mimeType} · {formatBytes(asset.sizeBytes)}</small>{previewState === "missing" && <p className="asset-warning">Attachment file unavailable. Remove it and import again.</p>}{previewState === "corrupted" && <p className="asset-warning">Attachment file may have been damaged or changed. Remove it and import again.</p>}{asset.assetType === "pdf" && <label className="asset-page">Page <input aria-label={`Page reference for ${asset.displayName}`} min={1} onBlur={() => void onPageReference(asset, pageValue)} onChange={(event) => setPageValue(event.target.value)} placeholder="Optional" type="number" value={pageValue} />{previewState === "ready" && preview && <a href={preview.assetUrl} rel="noreferrer" target="_blank">Open PDF</a>}</label>}</div>
    <button aria-label={`Remove ${asset.displayName}`} className="text-button danger" onClick={onRemove} type="button">Remove</button>
  </li>;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
