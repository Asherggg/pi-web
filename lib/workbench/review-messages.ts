const en = {
  "workbench.sessionVersionUnavailable": "This legacy conversation must be migrated by its owner before the read-only workbench can inspect it.",
  "workbench.review.truncated": "This report exceeds the review panel limit. Open its conversation for the full text; acceptance is unavailable here.",
  "workbench.result": "Result", "workbench.child": "Subtask", "workbench.lineage": "Task relationships", "workbench.dispatch": "Delegated",
  "workbench.review.title": "Review subtask result", "workbench.review.pending": "Pending review", "workbench.review.reviewed": "Reviewed", "workbench.review.accepted": "Accepted", "workbench.review.needs_changes": "Changes requested", "workbench.review.rejected": "Rejected", "workbench.review.stale": "Evidence changed; review again", "workbench.review.note": "Verification notes / requested changes", "workbench.review.done": "Mark reviewed", "workbench.review.accept": "Accept result", "workbench.review.changes": "Request changes", "workbench.review.reject": "Reject result", "workbench.review.gitSeparate": "These decisions record your review only. They neither send a new task nor merge Git branches.",
  "workbench.reportMismatch": "The report does not belong to this subtask.", "workbench.reportUnavailable": "The original result is unavailable. It cannot be accepted.", "workbench.reportChanged": "This subtask has continued or its report/files changed. Reopen the latest report to review it.", "workbench.reportNotAcceptable": "Only a completed result whose referenced files are available can be accepted.", "workbench.reviewFirst": "Mark this exact report and its current files as reviewed before accepting.", "workbench.reviewNoteRequired": "Describe the required changes or rejection reason first.",
  "workbench.fileState.available": "Available", "workbench.fileState.missing": "Missing", "workbench.fileState.outside": "Outside this checkout or a link", "workbench.fileState.limit": "Outside review limits", "workbench.fileState.changed": "Changed while reading", "workbench.review.show": "Open review", "workbench.review.previous": "Previous decision", "workbench.reviewsCorrupt": "Review settings could not be read; no acceptance is assumed.",
};
type Keys = keyof typeof en;
const cn: Record<Keys, string> = {
  "workbench.sessionVersionUnavailable": "此旧版会话需先由原会话运行器迁移，工作区只读查看不会改写历史。",
  "workbench.review.truncated": "报告超出核验面板上限，请在原会话查看全文；此处暂不能采纳。",
  "workbench.result": "结果", "workbench.child": "子任务", "workbench.lineage": "任务关系", "workbench.dispatch": "派生任务",
  "workbench.review.title": "核验子任务结果", "workbench.review.pending": "待核验", "workbench.review.reviewed": "已核验", "workbench.review.accepted": "已采纳", "workbench.review.needs_changes": "需修改", "workbench.review.rejected": "未采纳", "workbench.review.stale": "依据已变化，请重新核验", "workbench.review.note": "核验记录／修改意见", "workbench.review.done": "标记已核验", "workbench.review.accept": "采纳结果", "workbench.review.changes": "要求修改", "workbench.review.reject": "不采纳", "workbench.review.gitSeparate": "此操作只记录核验决定，不发送新任务，也不合并 Git 分支。",
  "workbench.reportMismatch": "该报告不属于此子任务。", "workbench.reportUnavailable": "原始结果已不可用，暂不能采纳。", "workbench.reportChanged": "子任务已继续运行，或报告／文件已变化，请打开最新报告重新核验。", "workbench.reportNotAcceptable": "仅能采纳已完成且引用文件仍可用的结果。", "workbench.reviewFirst": "请先核验这份报告及其当前文件，再采纳。", "workbench.reviewNoteRequired": "请先填写修改要求或不采纳的原因。",
  "workbench.fileState.available": "可用", "workbench.fileState.missing": "文件已缺失", "workbench.fileState.outside": "工作区外路径或链接", "workbench.fileState.limit": "超出核验上限", "workbench.fileState.changed": "读取期间已变化", "workbench.review.show": "打开核验", "workbench.review.previous": "上次决定", "workbench.reviewsCorrupt": "核验配置读取失败，当前不认定任何结果已采纳。",
};
const tw: Record<Keys, string> = {
  "workbench.sessionVersionUnavailable": "此舊版對話需先由原對話執行器遷移，工作區唯讀查看不會改寫歷史。",
  "workbench.review.truncated": "報告超出核驗面板上限，請在原對話查看全文；此處暫不能採納。",
  "workbench.result": "結果", "workbench.child": "子任務", "workbench.lineage": "任務關係", "workbench.dispatch": "派生任務",
  "workbench.review.title": "核驗子任務結果", "workbench.review.pending": "待核驗", "workbench.review.reviewed": "已核驗", "workbench.review.accepted": "已採納", "workbench.review.needs_changes": "需修改", "workbench.review.rejected": "未採納", "workbench.review.stale": "依據已變化，請重新核驗", "workbench.review.note": "核驗記錄／修改意見", "workbench.review.done": "標記已核驗", "workbench.review.accept": "採納結果", "workbench.review.changes": "要求修改", "workbench.review.reject": "不採納", "workbench.review.gitSeparate": "此操作僅記錄核驗決定，不傳送新任務，也不合併 Git 分支。",
  "workbench.reportMismatch": "該報告不屬於此子任務。", "workbench.reportUnavailable": "原始結果已無法使用，暫不能採納。", "workbench.reportChanged": "子任務已繼續執行，或報告／檔案已變化，請開啟最新報告重新核驗。", "workbench.reportNotAcceptable": "僅能採納已完成且引用檔案仍可用的結果。", "workbench.reviewFirst": "請先核驗這份報告及其目前檔案，再採納。", "workbench.reviewNoteRequired": "請先填寫修改要求或不採納的原因。",
  "workbench.fileState.available": "可用", "workbench.fileState.missing": "檔案已缺失", "workbench.fileState.outside": "工作區外路徑或連結", "workbench.fileState.limit": "超出核驗上限", "workbench.fileState.changed": "讀取期間已變化", "workbench.review.show": "開啟核驗", "workbench.review.previous": "上次決定", "workbench.reviewsCorrupt": "核驗設定讀取失敗，目前不認定任何結果已採納。",
};
export const reviewMessages = { en, "zh-CN": cn, "zh-TW": tw };
