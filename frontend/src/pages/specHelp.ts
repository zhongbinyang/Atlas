export const SPEC_HELP = {
  page: '产品规格上下限存在数据库。序列步骤引用模板 ID 和 Section 名，运行时按指标判 Pass/Fail。',
  iniImport: '兼容现有 *_Spec.ini：解析 [段] 与 *_UL/*_LL 后写入数据库。导入后可点「编辑」进入独立页改内容。',
  section: '对应 INI 的 [段名]，例如 FMT_HT。步骤里选 Spec 段时用这个名字，也支持 ${变量} 展开。',
  metric: '指标名，对应 INI 里 TX_AP_UL / TX_AP_LL 的 TX_AP。须与 VI 输出字段同名才能判定。',
  min: '下限（LL）。留空或填 inf 表示不限制。',
  max: '上限（UL）。留空或填 inf 表示不限制。',
  saveAs: '新建一份 Spec 模板，不会覆盖当前这份。要覆盖请用「保存」。',
} as const;
