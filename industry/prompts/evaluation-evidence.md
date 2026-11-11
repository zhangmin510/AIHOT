五、可空的评测属性 evaluation（技术属性，不替换以上栏目，不影响评分）

材料明确讨论评测基准、测量结果、评测方法、评测争议/更正、安全评测或 Agent 评测时，抽取 evaluation；普通发布/经营消息没有具体评测证据时返回 null。evaluationType 只能是 new_benchmark、evaluation_result、eval_method、eval_critique、safety_eval、agent_eval 或 null。没有明确依据时不能凭关键词认定。

evaluation 格式：
{"evaluationType":"evaluation_result","claims":[{"model":null,"modelVersion":null,"benchmark":null,"benchmarkVersion":null,"metric":null,"value":null,"unit":null,"split":null,"conditions":[],"sampleSize":null,"confidenceInterval":null,"attribution":null,"codeUrl":null,"dataUrl":null,"dataAvailability":null,"supportingQuote":"原文中支持这一组字段的连续片段","locator":null}]}

- 每条 claims 对应同一模型/版本、同一基准/版本、同一 split 和条件下的一项原文主张，最多六条。不要把表格不同列、不同测试条件的字段拼接。
- supportingQuote 必须是输入原文的连续片段，8–1200字符，包含该条主张的对象、指标、数字、单位与已知条件；locator 仅作章节/表格名称提示，实际位置由程序回到原文核对。不能自创证据、翻译证据或用推荐理由作证据。
- value 只能是 JSON number 或 null，禁止字符串、区间字符串、带单位字符串或用区间端点代替单点值；unit 是原文单位。绝对百分数写 value=87.2、unit="%"。提高了/降低了/by 95% 是变化幅度，不能写成指标绝对值95%；11%–35%是范围，不能任选11或35。当前字段不能准确保留比较对象、变化方向或范围时，claims=[]，或保留可定位名称但 value=null、unit=null；不要强转、猜测或凑数。提高到/to 80%才表示结果值80%，仍须原文明确支持。confidenceInterval 是 {"lower":0,"upper":0,"level":null} 或 null，只有原文明确说是置信区间时才能填写；跨模型或场景范围不是置信区间。sampleSize 必须是明确样本数。
- model、metric、benchmark、split、conditions 必须使用 supportingQuote 里实际连续出现的原词/词句，不翻译、不扩写全称、不用概括短语替代。benchmark若只出现在标题而不在该连续片段中，此claim的benchmark写null；不要为填齐字段拼接不连续片段。版本单独写到 modelVersion/benchmarkVersion；未知项为 null/[]，不能强补模型或实验协议。
- attribution 为 vendor（对自家效果的主张）或 third_party（独立方实际运行的结果），无法确认则 null；不要因其是论文、基准作者或第三方信源就强填third_party，转述厂商结果不构成独立测试。
- codeUrl/dataUrl 必须是当前输入实际出现的公开 http(s) 链接，不能推测地址。dataAvailability 只有明确说明公开或受限时才写 public/restricted，否则 null；没看到数据链接不等于不开放。
- 若材料是评测相关但缺少可定位证据，保留 evaluationType，claims=[]，交程序标记待复核。程序会验证数值、版本、条件与原文对应；不能让不匹配的结果靠口头解释通过。
