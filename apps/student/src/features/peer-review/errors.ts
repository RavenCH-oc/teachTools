export function peerError(code: string): string {
  switch (code) {
    case "TARGET_REVIEW_CAPACITY_FULL": return "這份作品的互評名額剛剛已滿，請選擇其他作品。";
    case "REVIEW_TARGET_LOCKED_AFTER_SUBMISSION": return "已提交評論後不能更換互評對象。";
    case "REVIEW_REVISION_CONFLICT": return "這份評論已被更新，請先載入最新版本。";
    case "PEER_REVIEW_CLOSED": return "同儕互評活動已結束。";
    case "REVIEW_SUBMISSION_CONFLICT": return "上一筆提交狀態與目前內容不一致，請重新載入後再試。";
    default: return "無法取得這份互評內容，請重新整理。";
  }
}
