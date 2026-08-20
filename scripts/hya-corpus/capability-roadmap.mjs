import { summarizeFeatureAttribution } from './feature-attribution.mjs';

const GUIDANCE = Object.freeze({
  'layers/precomp': {
    label: '嵌套 Precomp', owner: 'converter', priority: 'done', kind: 'implemented',
    strategy: '已展开为来源无关的 HYA 节点与普通 track；保留 parent、opacity、in/out、start、stretch 和单调 time-remap。',
  },
  'operators/merge-path': {
    label: 'Merge Paths', owner: 'converter', priority: 'P0', kind: 'converter',
    strategy: '静态 Merge/Add/Subtract/Intersect/Exclude 已在转换期完成；动画 mode 1 已按素材帧率烘焙为稳定 compound morph，动画 boolean topology 继续精确诊断。',
  },
  'shapes/path': {
    label: 'Path 数据兼容', owner: 'converter', priority: 'P0', kind: 'source-normalization',
    strategy: '对真实 Bodymovin 的空切线、单点和不规则 keyframe 包装做规范化；几何确实损坏时继续拒绝，不能用零路径静默替代。',
  },
  'shapes/primitive-size': {
    label: 'Primitive 动态尺寸', owner: 'converter', priority: 'P0', kind: 'source-normalization',
    strategy: '从第一个有效 keyframe 建立基准 geometry，再将尺寸变化转为 scale 或 vector geometry track；全程非正尺寸才判源数据无效。',
  },
  'styles/stroke': {
    label: 'Stroke 宽度兼容', owner: 'converter', priority: 'P0', kind: 'source-normalization',
    strategy: '允许动画首帧为零宽并保留后续正值；全程零宽按合法不可见 stroke 省略，只有负宽度才输出来源诊断。',
  },
  'animation/path-topology': {
    label: 'Path Topology 归一', owner: 'converter', priority: 'P1', kind: 'converter',
    strategy: '动画轮廓已统一 cubic command、闭合方向和起点；顶点数变化用无损 de Casteljau 细分，并保留 256 segment 安全预算。',
  },
  'animation/path': {
    label: 'Animated Path', owner: 'converter', priority: 'P1', kind: 'converter',
    strategy: '复用 topology 归一器输出 vector morph；无法满足误差或顶点预算的素材明确进入离线 bake/no-go。',
  },
  'composites/stack-budget': {
    label: 'Mask/Matte 栈预算', owner: 'format-runtime', priority: 'P1', kind: 'format-runtime',
    strategy: '优先把超过 8 层的栈分解为多个嵌套 composite node；真实 GPU 证明 pass/显存可接受后再考虑提升单节点 ABI 上限。',
  },
  'animation/mask-expansion': {
    label: 'Animated Mask Expansion', owner: 'format-runtime', priority: 'P1', kind: 'format-runtime',
    strategy: '为 composite expansion 增加普通 scalar track，并在 tessellation/cache key 中纳入时间采样；同步建立像素和几何重建预算。',
  },
  'timing/time-stretch': {
    label: '非 Precomp Time Stretch', owner: 'converter', priority: 'P1', kind: 'converter',
    strategy: '为每个普通 layer 建立局部 timeline，统一重映射 transform、shape、text、effect 与 composite 参数，避免只改部分 track。',
  },
  'text/font-substitution': {
    label: 'Web Font 映射', owner: 'implemented', priority: 'done', kind: 'implemented',
    externalDiagnosticCodes: ['W_LOTTIE_FONT_SUBSTITUTION'],
    strategy: '显式 Web Font 映射已完整支持；未映射字体保留来源 family、style 和 weight，由浏览器按与官方 Player 相同的系统字体规则 fallback。字体不可用 diagnostic 属于运行环境提示，不计为能力降级。',
  },
  'animation/text-selector': {
    label: '高级 Text Selector', owner: 'format-runtime', priority: 'P2', kind: 'format-runtime',
    strategy: '支持 character/排除空格/word/line 分组、shape easing、smoothness 和基于导入路径稳定种子的随机排列；expression selector 继续单独归入脚本安全边界。',
  },
  'layers/parent': {
    label: 'Parent 层级', owner: 'source', priority: 'source', kind: 'source-validation',
    strategy: '被引用的 hidden parent 已保留为 transform-only node，并递归保留隐藏祖先；只有来源中确实不存在的 parent 才输出精确路径且不猜测替代层。',
  },
  'layers/unknown': {
    label: '未知 Layer 类型', owner: 'product', priority: 'P2', kind: 'product-decision',
    strategy: '按真实 layer 语义单独建模；不得复用错误的可视 layer 类型，也不得把未知层静默计作已支持。',
  },
  'layers/data': {
    label: 'Lottie Data Layer', owner: 'format-runtime', priority: 'P2', kind: 'format-runtime',
    strategy: 'type 15 作为来源无关 binary data resource 与非视觉 node extension 保留，不把它错误地当作图片或未知可视 layer。',
  },
  'expressions/text-document': {
    label: 'Text Document Expression', owner: 'product-security', priority: 'no-go', kind: 'security-boundary',
    strategy: 'HYA runtime 不执行任意 Lottie JavaScript；导入器保留静态 fallback 和精确表达式路径，动态结果应由可信离线工具 bake。',
  },
  'conversion/no-renderable-shape': {
    label: '无可渲染 Shape', owner: 'diagnostics', priority: 'derived', kind: 'derived',
    strategy: '空顶点 Path 已作为合法 no-op；其余情况是上游 merge-path、path 或 primitive 失败的派生结果，dashboard 不应把它当成独立渲染 feature。',
  },
});

export function createCapabilitySnapshot(samples, {
  generatedAt = new Date().toISOString(),
  gitRevision = 'unknown',
  workingTreeDirty = false,
} = {}) {
  const features = summarizeFeatureAttribution(samples).map(feature => {
    const configuredGuidance = GUIDANCE[feature.feature] ?? defaultGuidance(feature);
    const externalDiagnosticCodes = new Set(configuredGuidance.externalDiagnosticCodes ?? []);
    const hasCapabilityFailure = feature.diagnosticCodes.some(code => !externalDiagnosticCodes.has(code));
    const capabilityFeature = feature.failureCount > 0 && !hasCapabilityFailure
      ? { ...feature, status: 'full', affectedSampleCount: 0, failureCount: 0, diagnosticCodes: [] }
      : feature;
    const guidance = capabilityFeature.status === 'full'
      ? { ...configuredGuidance, owner: 'implemented', priority: 'done', kind: 'implemented' }
      : configuredGuidance;
    return {
      feature: capabilityFeature.feature,
      label: guidance.label ?? capabilityFeature.feature,
      status: capabilityFeature.status,
      sampleCount: capabilityFeature.sampleCount,
      occurrenceCount: capabilityFeature.occurrenceCount,
      affectedSampleCount: capabilityFeature.affectedSampleCount,
      failureCount: capabilityFeature.failureCount,
      diagnosticCodes: capabilityFeature.diagnosticCodes,
      owner: guidance.owner,
      priority: guidance.priority,
      kind: guidance.kind,
      strategy: guidance.strategy,
    };
  });
  const counts = countBy(features, feature => feature.status);
  return {
    schemaVersion: 1,
    kind: 'hya-capability-support',
    generatedAt,
    sourceState: { gitRevision, workingTreeDirty },
    methodology: 'Current converter diagnostics over the pinned corpus. This support snapshot is independent from formal fidelity/performance evidence.',
    summary: {
      featureCount: features.length,
      fullCount: counts.full ?? 0,
      partialCount: counts.partial ?? 0,
      unsupportedCount: counts.unsupported ?? 0,
      precompStatus: features.find(feature => feature.feature === 'layers/precomp')?.status ?? 'not-observed',
    },
    features: features.sort(compareCapability),
  };
}

function defaultGuidance(feature) {
  if (feature.status === 'full') return {
    owner: 'implemented', priority: 'done', kind: 'implemented',
    strategy: '当前固定语料没有转换 diagnostic；继续以新增真实素材和像素回归守住该能力。',
  };
  return {
    owner: 'triage', priority: 'P2', kind: 'investigate',
    strategy: '先补最小真实 fixture 和精确失败路径，再决定由 converter、格式 ABI、runtime 或创作工具承担。',
  };
}

function compareCapability(a, b) {
  const status = { unsupported: 0, partial: 1, full: 2 };
  const priority = { P0: 0, P1: 1, P2: 2, 'no-go': 3, source: 4, derived: 5, done: 6 };
  return status[a.status] - status[b.status]
    || (priority[a.priority] ?? 9) - (priority[b.priority] ?? 9)
    || b.affectedSampleCount - a.affectedSampleCount
    || b.failureCount - a.failureCount
    || a.feature.localeCompare(b.feature);
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
