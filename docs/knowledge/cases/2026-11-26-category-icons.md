# 案例：一级分类图标（参考风格复刻）

- 日期：2026-11-26
- 工具链：dsh-ui-restore（像素分析/截图/审计）+ Paper MCP（画板、`paper-gen://` 图像生成）+ 视觉模型（读图核对）
- 结论：两页共 20 个分类图标，整卡浅色底 + 3D 商品 + 大号标签；生成 20/20 成功，两轮迭代达到参考风格。

## 1. 输入

### 1.1 参考图

- 本地文件：`C:\Users\23051\Downloads\图标.png`（1754×832，5 个分类卡片：粮油/家清/休闲/饮料/生鲜）。
- 参考图**不复制进仓库**（含真实品牌商品）；只记录规格与本案例产出。

### 1.2 商品图链接（15 张，透明底）

```text
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153819682.png   大米袋+食用油+酱油
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153813678.png   力士洗护+牙膏
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153807669.png   电水壶
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153803665.png   锅具+刀叉勺
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153757662.png   双肩包+保温杯
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153740624.png   奶粉+奶瓶
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153752659.png   键盘+鼠标
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153746655.png   行李箱+背包
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153732597.png   抽纸+卷纸
https://static.gxghhzxh.com/fe/shop-h5/cake/1792630511.png          手机+鼠标
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153721557.png   零食袋+坚果
https://static.gxghhzxh.com/fe/shop-h5/cake/20260707153713552.png   红包+灯笼
https://static.gxghhzxh.com/fe/shop-h5/cake/20260731155949426.png   行李箱+绿色包
https://pub-ztc-pro.oss-cn-beijing.aliyuncs.com/ecshop/5485ae6ed00e4ce091fcf517322f106d.png  露营灯+望远镜
https://pub-ztc-pro.oss-cn-beijing.aliyuncs.com/ecshop/a0981ecac10f4bd9a1a75d3796eeb68f.png  咖啡豆+吸管杯
```

用途：作为风格与商品语义参考（透明底 3D 商品）。**未直接拼贴进最终稿**。

### 1.3 分类名单（20 个）

| 第 1 页 | 第 2 页 |
| --- | --- |
| 粮油调味、家清纸品、休闲食品、饮料冲调、生鲜水果 | 母婴用品、数码影音、运动户外、护理护具、汽车用品 |
| 食品特产、个护清洁、生活电器、家居日用、美妆护肤 | 箱包皮具、服装鞋靴、工业劳保、企业办公、节日套餐 |

## 2. 输出

- Paper 文件「直通车官网」→ 页面 **分类图标** → 两个画板：
  - `分类图标-第1页`（1200×700，10 个）
  - `分类图标-第2页`（1200×700，10 个）
- 截图：[page1](../assets/category-icons-page1.jpg) / [page2](../assets/category-icons-page2.jpg)
- 风格规格：[style-tokens.json](../templates/style-tokens.json)
- 提示词配方：[prompts.json](../templates/prompts.json)
- 图块模板：[icon-tile.html](../templates/icon-tile.html)

## 3. 风格规格（实测 + 设计）

| 项 | 参考图 | 本案例 |
| --- | --- | --- |
| 卡片 | 275×275，圆角约 60（≈22%） | 196×196，圆角 44（≈22.4%） |
| 底色 | 奶油黄 `#FCF4D8→#FCF0CC`、淡蓝 `#D8F0FF→#CCECFF`、淡绿 `#E4FCDC→#DCF8D0`、蜜桃 `#FCE4D8→#FCDCCC`、暖杏 `#FCECC4→#FCE8B8` | 同色系扩展到 20 个品类；**整卡 edge-to-edge**，无棚拍灰、无内层色块 |
| 商品 | 真实商品照片/3D，占卡约 80%，底部软阴影 | 生成 3D 商品，占卡 70–85%，软接触阴影 |
| 标签 | 大号粗体中文，近黑 | 22px / 700，行高 28，居中，`#1A1A1A` |
| 版式 | 5 列 | 5 列；卡片间距 26，标签距卡 14；画板内边距 40/50 |
| 页面 | 白底 | 白底，标题 24/700 + 副标 12 |

## 4. 可复现步骤

1. **确认图像能力**：模型路由声明 `inputModalities: [text, image]`（DSH）；否则 `read_image` 不可用。
2. **看参考图与源图**：提取底色/圆角/占比/标签规格；把 15 张源图拼版确认商品语义。
3. **写提示词**（模板见 `templates/prompts.json`）：
   `Realistic 3D e-commerce category icon, square composition: <products> standing directly on a flat <bg> pastel background. The pastel color fills the entire square edge-to-edge. No pedestal, no platform, no studio floor, no backdrop, no table. Products fill most of the frame, soft contact shadows, soft studio lighting, no text, no logo, clean minimal, high detail`
4. **在 Paper 里生成**：`<img src="paper-gen://google-nano-banana-2-1?prompt=<urlencoded>&aspect_ratio=1:1">`；单次工具调用 ≤10 张图，按行（5 张/次）分批。
5. **轮询状态**：`get_node_info` 的 `imageGeneration.status` 到 `ready`/`error`。
6. **截图目检**：`get_screenshot` 每页一张，逐张核对「整卡底色 / 无底座 / 商品占比 / 无文字 / 标签对齐」。
7. **单张重生成**：不合格的品类只重生成那一张（同提示词加更明确的负向约束），不要全量重来。
8. **归档**：删除旧版画板；截图与配方存入知识库。

## 5. 验收清单

- [ ] 整卡浅色底，四边无灰底、无内层色块
- [ ] 无展示台/底座/棚拍地板/背景板
- [ ] 商品占卡 70–85%，不裁切、不贴边
- [ ] 圆角一致，四角干净
- [ ] 生成图内无文字、无 logo、无品牌名
- [ ] 每页 10 个，5 列对齐；标签居中、字号一致
- [ ] 同页色板不冲突；分类语义一眼可辨
- [ ] 旧版已删除/归档

## 6. 复盘：首版错在哪、v2 修了什么

| 问题 | 首版表现 | 修正 |
| --- | --- | --- |
| 底座 | 商品站在展示台上 | 提示词加 `no pedestal / no platform / no studio floor / no backdrop / no table` |
| 底色 | 一半是灰棚 + 内层色块 | 加 `the pastel color fills the entire square edge-to-edge` |
| 占比 | 商品约 60% | 加 `products fill most of the frame` |
| 标签 | 18px 偏小 | 22px / 700，行高 28 |

## 7. 经验（可迁移）

1. **模态先行**：先确认模型真的声明了图像输入；profile 覆盖模型表时容易丢掉 `inputModalities`（本次就是被覆盖成纯文本）。
2. **「底」也是风格**：参考图的浅色圆角卡、标签、占比都属于风格；只提取透明物件会做成另一种东西。
3. **生成模型别写文字**：标签用 HTML 叠加；生成图内加 `no text, no logo`。
4. **负向约束比正向更有效**：底座、棚拍地板、背景板是最常见的跑偏，必须显式写「不要」。
5. **必须逐张目检**：结构指标（溢出/对齐/裁切）测不出「像不像」；每页看图，再决定重生成。
6. **单张重生成**：20 张里通常只有 2–4 张需要返工，按品类单独重跑，节省额度。
7. **版本隔离**：旧画板先删再建，避免文件夹里堆三代设计。
8. **记录消耗**：每次生成 1 usage，本次两轮约 41 次（含测试），下次先规划批量。

## 8. 已知限制

- 生成图是 AI 泛化商品，不是真实品牌商品；需要真实商品图时仍应使用商家素材（注意授权）。
- 图像生成有额度与随机性；同提示词重跑结果会变，保留最终种子/提示词以便复现近似效果。
- 视觉核对依赖图像输入模型；纯文本模型只能做结构验收，不能判断风格。
