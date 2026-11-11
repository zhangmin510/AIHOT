// 主题准入与精选评分分开管理；旧版宽泛 AI 相关性结果不等于本版准入证明。
export const CONTENT_SCOPE = {
  key: "ai-evaluation",
  version: "evaluation-only-v1",
  /** 只有当前范围政策下明确通过的材料才可公开；UNKNOWN 保留内部待审。 */
  requireExplicitPass: true,
} as const;
