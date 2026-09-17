import content from "../.generated/lab-content.json" with { type: "json" };

// 三维档案 adapter：读取构建时生成的公开内容目录，建立 postId -> href 索引，
// 并校验没有悬空引用。只读取公开文章摘要，不加载 Markdown 正文。

export interface LabSlot {
  id: string;
  displayNumber: number;
  postId: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  href: string;
}

export interface LabContent {
  generatedAt: string;
  site: string;
  columns: string[];
  categories: string[];
  records: LabSlot[];
}

const lab = content as LabContent;

const problems: string[] = [];
if (!Array.isArray(lab.columns) || lab.columns.length !== 5) {
  problems.push("columns 必须是 5 个策展主题");
}
if (!Array.isArray(lab.records)) problems.push("records 必须是数组");

const hrefByPostId = new Map<string, string>();
for (const record of lab.records) {
  if (!record.postId || !record.href) {
    problems.push(`槽位 ${record.id} 缺少 postId 或 href`);
    continue;
  }
  if (!record.href.startsWith("/")) {
    problems.push(`槽位 ${record.id} 的 href 必须是站内绝对路径：${record.href}`);
  }
  const existing = hrefByPostId.get(record.postId);
  if (existing && existing !== record.href) {
    problems.push(`文章 ${record.postId} 在不同槽位的 href 不一致`);
  }
  hrefByPostId.set(record.postId, record.href);
}
if (problems.length) {
  throw new Error(`lab 内容校验失败：\n- ${problems.join("\n- ")}`);
}

export const labContent = lab;
export const hasPosts = lab.records.length > 0;
export function hrefForPost(postId: string): string | null {
  return hrefByPostId.get(postId) ?? null;
}
