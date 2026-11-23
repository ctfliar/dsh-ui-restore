# static-demo（无外网、无构建的夹具）

三个静态页面 + 两份 ui-spec，用来演示并自测插件能力：

| 文件 | 用途 |
| --- | --- |
| `index.html` | 设计基准页（列表页：侧栏 200 + 顶栏 52 + 统计卡 + 表格 + 分页） |
| `variant.html` | 与基准页有 3 处已知差异：标题字号 24px、主按钮红色、卡片 padding 24px |
| `audit.html` | 故意制造问题：横向溢出、图片缺 alt、无焦点按钮、内联硬编码颜色、可疑空态、9px 字号 |
| `ui-spec.json` | 与 `index.html` 对应的样式契约（用于 ui_probe 契约模式） |
| `ui-spec-invalid.json` | 非法契约（未知属性 / 非法颜色 / 空 selector / 未知顶层字段） |

## 在本地跑

```bash
# 1) 采基准截图（file:// 相对路径也支持）
#    ui_capture { "url": "examples/static-demo/index.html", "run": "output/ui-restore/demo" }
# 2) 采有缺陷实现的截图
#    ui_capture { "url": "examples/static-demo/variant.html", "run": "output/ui-restore/demo-bad" }
# 3) 差异对比（设计图用第 1 步的 shot.png）
#    ui_diff { "design": ".../demo/shot.png", "shot": ".../demo-bad/shot.png", "run": ".../demo-bad" }
# 4) 样式契约探针
#    ui_probe { "url": "examples/static-demo/index.html", "expected": "examples/static-demo/ui-spec.json", "profile": "static-demo" }
# 5) 报告
#    ui_report { "run": ".../demo-bad", "profile": "static-demo" }
```

浏览器能力可用时，`npm run selftest:browser` 会自动跑完上面这条链路（产物落在系统临时目录，
不会污染仓库）。
