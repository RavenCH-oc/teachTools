import { invoke } from "@tauri-apps/api/core";
import { monitorQuerySchema,monitorSummarySchema,monitorActivitiesSchema,monitorStatusesSchema,monitorRevisionsSchema } from "@classtools/validation";
type Query={limit?:number;cursor?:string};
export type MonitorKind="reviewers"|"targets"|"uncovered"|"reviews";
async function read<T>(command:string,args:Record<string,unknown>,parse:(value:unknown)=>T):Promise<T>{
  try {return parse(await invoke<unknown>(command,args));}
  catch {throw new Error("無法讀取互評紀錄；請確認課堂與活動後重新整理。");}
}
export const peerReviewMonitorApi={
  activities:(sessionId:string,query:Query={})=>read("list_peer_review_monitor_activities",{sessionId,query:monitorQuerySchema.parse(query)},monitorActivitiesSchema.parse),
  summary:(sessionId:string,activityId:string)=>read("get_peer_review_monitor_summary",{sessionId,activityId},monitorSummarySchema.parse),
  statuses:(sessionId:string,activityId:string,kind:MonitorKind,query:Query={})=>read("list_peer_review_monitor_statuses",{sessionId,activityId,kind,query:monitorQuerySchema.parse(query)},monitorStatusesSchema.parse),
  revisions:(sessionId:string,activityId:string,assignmentId:string,latest:boolean,query:Query={})=>read("list_peer_review_record_revisions",{sessionId,activityId,assignmentId,latest,query:monitorQuerySchema.parse(query)},monitorRevisionsSchema.parse),
};
export type PeerReviewMonitorApi=typeof peerReviewMonitorApi;
