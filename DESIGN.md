---
name: "FlareS3"
description: "轻量、可靠、高效的个人云端存储与分享工具。"
colors:
  ink: "#383838"
  white: "#ffffff"
  page-bg: "#f4efea"
  surface: "#ffffff"
  primary-yellow: "#ffde00"
  duck-blue: "#6fc2ff"
  deep-blue: "#2ba5ff"
  teal-success: "#53dbc9"
  purple: "#b291de"
  lime: "#b3c419"
  orange-warning: "#ff9538"
  salmon-danger: "#ff7169"
  neutral-50: "#fffefc"
  neutral-100: "#f8f8f7"
  neutral-200: "#e9e3dd"
  neutral-300: "#d8d2cc"
  neutral-400: "#a1a1a1"
  neutral-500: "#6b6b6b"
  dark-bg: "#0f0f10"
  dark-surface: "#171717"
typography:
  display:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "32px"
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: "0.02em"
  headline:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "24px"
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: "0.02em"
  title:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "18px"
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: "0.02em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica Neue, Arial, Noto Sans, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.02em"
rounded:
  sharp: "2px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "9999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary-yellow}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "0 22px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.duck-blue}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "0 22px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.salmon-danger}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "0 22px"
    height: "44px"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "0 14px"
    height: "36px"
  card-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sharp}"
    padding: "24px"
  input-default:
    backgroundColor: "{colors.neutral-100}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sharp}"
    padding: "0 16px"
    height: "44px"
  tag-primary:
    backgroundColor: "{colors.primary-yellow}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "4px 10px"
---

# Design System: FlareS3

## 1. Overview

**Creative North Star: "Cloud Control Desk"**

FlareS3 的视觉系统像一张紧凑的个人云端控制台：默认主题有明确边框、硬朗阴影和高对比色块，但每个视觉动作都必须服务上传、查找、分享、配置和审计。它可以轻快、有识别度，但不能变成装饰性作品。

系统默认使用 MotherDuck Neo-Brutalist 主题，适合强调工具感、状态感和可点击性；同时保留 shadcn/ui neutral 主题，供用户切换到更克制、更紧凑的界面语言。两个主题共用同一套组件 API，禁止出现同一操作在不同页面里像两个产品的情况。

该系统明确拒绝 PRODUCT.md 中的两个反参考：不要像传统企业网盘，不要营销页感。视觉密度应支持个人高频操作，管理能力应完整但不抢占主流程。

**Key Characteristics:**
- 高对比边框和状态色让操作结果清楚可见。
- 默认主题以黄色主操作和蓝色辅助操作建立轻快工具感。
- 表格、卡片、筛选器和弹窗承载密集信息，不使用宣传式版面。
- 深浅色和中英文都必须保持可读、可扫、可操作。

## 2. Colors

调色板以硬朗中性色为骨架，用黄色、蓝色和少量语义色表达主操作、导航选中和状态反馈。

### Primary
- **Control Yellow**: 主操作、当前选中、关键表头和账户头像的默认承载色。它应该少量出现，用来告诉用户哪里可以立即行动。
- **Charcoal Ink**: 正文、边框、图标和硬阴影的核心颜色。它让默认主题保持清晰和可信。

### Secondary
- **Duck Blue**: 辅助操作、模态标题和信息提示。它比主黄色更安静，适合次级但仍可点击的区域。
- **Deep Focus Blue**: 焦点环、链接 hover 和输入聚焦。它只用于交互反馈，不能当装饰色铺开。

### Tertiary
- **Signal Teal**: 成功、可用、配置完成。
- **Warning Orange**: 临期、待配置、需要注意。
- **Salmon Danger**: 删除、禁用、失败和不可逆操作。
- **Purple and Lime**: 仅用于品牌预览、图表或少量分类辅助，不作为页面主色。

### Neutral
- **Warm Control Background**: 默认页面背景，承托硬边框和白色表面。
- **Surface White**: 卡片、弹窗、输入和表格容器。
- **Soft Dividers**: 次级边线、空状态、禁用态和表格 hover 的柔和中性色。
- **Dark Operating Surface**: 深色模式使用近黑背景和深灰表面，保留高对比文本、边框与状态色。
- **shadcn Neutral Set**: 可切换主题使用 OKLCH neutral 语义色，包括 `background`、`foreground`、`card`、`primary`、`secondary`、`muted`、`accent`、`destructive`、`border`、`input` 和 `ring`。它是更克制的产品模式，不替代默认身份。

### Named Rules

**The Accent Scarcity Rule.** Control Yellow 用于主操作、当前选择和关键状态，单屏占比必须保持低，不能变成背景装饰。

**The Status Means State Rule.** Teal、Orange、Salmon 只表达成功、警告、危险等状态，不用于普通卡片装饰。

## 3. Typography

**Display Font:** JetBrains Mono，回退到系统等宽字体。  
**Body Font:** Inter，回退到 system-ui、Noto Sans。  
**Label/Mono Font:** JetBrains Mono。shadcn 主题使用 Geist Sans 和 Geist Mono 作为更克制的替代。

**Character:** 默认主题用等宽标题和 UI 标签强调工具面板感，正文用 Inter 保持长文本和表格内容可读。shadcn 主题把标题、标签和正文收束到 Geist Sans，降低装饰性，提高产品熟悉度。

### Hierarchy
- **Display** (900, 32px, 1.2): 页面主标题、仪表盘大数字和品牌标识。产品界面内不要使用超过当前 32px 到 40px 的展示级文字。
- **Headline** (900, 24px, 1.2): 页面区块标题和重要面板标题。
- **Title** (900, 18px, 1.2): 卡片标题、弹窗标题、配置分组标题。
- **Body** (400, 16px, 1.5): 表单说明、段落、列表和普通内容。长文本保持 65 到 75 字符宽度。
- **Label** (700, 14px, 0.02em): 按钮、导航、字段标签和状态标签。默认主题可大写；shadcn 主题必须使用正常大小写和 0 字距。

### Named Rules

**The Product Scale Rule.** 产品界面使用固定字号，不用宣传页式流体大标题。若表格、侧栏或移动端标题溢出，先缩小或换行，不允许撑破容器。

**The Label Consistency Rule.** 同一类操作标签必须使用同一字体、粗细、字距和大小写策略；不要在同一主题里混用等宽标签和普通 sans 标签。

## 4. Elevation

系统使用双重深度语言。默认主题用硬阴影和位移表达可点击性，shadcn 主题用低强度阴影和边线表达层级。两者都不使用宽模糊阴影作为装饰，也不使用玻璃拟态作为默认表面。

### Shadow Vocabulary
- **Brutal Small Lift** (`box-shadow: -4px 4px 0px 0px var(--nb-shadow-color)`): 小按钮、用户触发器和轻量 hover。
- **Brutal Surface Lift** (`box-shadow: -5px 5px 0px 0px var(--nb-shadow-color)`): 默认卡片、表格容器、弹出菜单。
- **Brutal Modal Lift** (`box-shadow: -8px 8px 0px 0px var(--nb-shadow-color)`): 模态框和高优先级覆盖层。
- **shadcn Low Shadow** (`box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`): 克制主题中的按钮、卡片和弹层。
- **Mobile Sheet Shadow** (`box-shadow: 0 18px 48px color-mix(in srgb, var(--nb-shadow-color) 36%, transparent)`): 移动端更多面板，配合底部遮罩使用。

### Named Rules

**The State Lift Rule.** 默认主题的阴影应跟随 hover、active 和弹层状态出现；静态内容不要为了装饰额外增加阴影。

**The No Ghost Card Rule.** 不要把 1px 边框和 16px 以上模糊阴影叠成装饰卡片。产品表面要么靠硬边框和硬阴影，要么靠 shadcn 的低阴影和边线。

## 5. Components

### Buttons

按钮是任务推进的主要控件，必须直接、稳定、可扫。

- **Shape:** 默认主题使用锐利小圆角 (2px)，shadcn 使用 8px 左右的中性圆角。
- **Primary:** 默认主题为 Control Yellow 背景、Charcoal Ink 文本、2px 边框，高度 44px；小尺寸 36px，大尺寸 52px。
- **Hover / Focus:** 默认主题 hover 位移 4px 并出现硬阴影；active 回到原位。shadcn 主题使用 150ms 颜色和焦点环反馈，不位移。
- **Secondary / Ghost / Default:** Secondary 使用 Duck Blue；Danger 使用 Salmon；Ghost 只在 hover 时显露浅背景和边框；Default 用白色表面承载普通命令。

### Chips

标签用于状态和过滤，不用于装饰。

- **Style:** 默认主题为硬边框矩形，10px 到 12px 字号。shadcn 主题为 pill 标签。
- **State:** Success、Warning、Danger、Info 必须对应真实系统状态。不要用状态色做分类装饰。

### Cards / Containers

卡片承载信息组，不作为页面分节装饰。

- **Corner Style:** 默认主题 2px，shadcn 主题 12px。
- **Background:** 默认 Surface White，深色模式切换到 Dark Surface。
- **Shadow Strategy:** 默认卡片使用 Brutal Surface Lift；shadcn 卡片使用低阴影和 1px 边线。
- **Border:** 默认主题 2px Charcoal Ink；shadcn 主题 1px semantic border。
- **Internal Padding:** 桌面 24px，移动端降到 16px。

### Inputs / Fields

输入组件必须优先保证可读、可聚焦、可清除。

- **Style:** 默认主题使用 2px 边框、半透明 neutral 输入背景和 44px 中尺寸高度；shadcn 使用 1px input 边框、40px 中尺寸高度。
- **Focus:** 默认主题切换到 Deep Focus Blue 边框和 2px focus ring；shadcn 使用 `ring` 加背景 offset 的双层焦点。
- **Error / Disabled:** 禁用态使用浅灰背景、低对比文字和不可用光标。错误态应使用 Salmon Danger 并保留文字说明。

### Navigation

桌面端使用左侧固定栏，移动端使用四项底部 tabbar 和更多面板。

- **Desktop:** 侧栏 240px，可折叠到 72px。导航项默认透明，hover 显示浅背景和边框，active 使用 Control Yellow。
- **Mobile:** 底部 tabbar 固定在视口底部，4 列布局，active 项使用主色 12% 到 14% 的浅底。更多菜单使用底部 sheet，包含账户、主题、语言和低频管理入口。
- **Theme Switching:** 导航和弹窗里提供深浅色、UI 主题和语言切换。新增入口必须同时适配这三类切换。

### Tables

表格是文件、文档、分享、用户和审计的核心阅读模式。

- **Default Theme:** 容器有边框和硬阴影，表头使用 Control Yellow，单元格 12px 16px 内边距，固定表格布局配合省略号。
- **shadcn Theme:** 表格去掉外框装饰，使用 1px 行分隔、48px 表头高度和 muted hover。
- **Empty / Loading:** 空表格使用居中状态文案；首次加载使用 skeleton 或覆盖层，不在内容中央裸放长期 spinner。

### Dialogs and Sheets

弹窗只用于确认、编辑、分享和配置这类需要打断的任务。

- **Desktop Dialog:** 默认主题使用硬边框、硬阴影、彩色标题栏和右上关闭按钮；shadcn 使用 Radix Dialog、模糊遮罩、1px 边框和紧凑标题。
- **Mobile Sheet:** 更多菜单从底部进入，圆角 24px 顶部、带抓手和滚动锁定。该模式只用于移动端低频入口，不替代表单内联编辑。

## 6. Do's and Don'ts

### Do:

- **Do** 使用默认 MotherDuck Neo-Brutalist 主题作为主身份，新增组件必须先适配 `--nb-*` token。
- **Do** 同时验证 shadcn 主题，确保同一组件 API 在两个主题下结构一致、状态一致。
- **Do** 保持表格、筛选器、卡片和弹窗的产品密度，优先支持上传、查找、分享、配置、审计和清理。
- **Do** 使用 Control Yellow 标记主操作和当前选择，使用 Deep Focus Blue 标记焦点。
- **Do** 为中文和英文预留文本伸缩空间，按钮、表格列、弹窗标题和底部导航都不能截断关键动作。
- **Do** 保持 WCAG AA，对正文、占位文本、状态标签、按钮和输入焦点做对比度检查。

### Don't:

- **Don't** 做成传统企业网盘。不要让臃肿导航、重权限概念和低频管理功能压过个人文件与文档主流程。
- **Don't** 做成营销页感。不要使用夸张 hero、宣传文案、装饰性指标、渐变文字或为了展示而展示的动效。
- **Don't** 把状态色当装饰色。Teal、Orange、Salmon 必须对应真实状态。
- **Don't** 在产品表面使用玻璃拟态、装饰性大阴影、重复卡片网格或侧边彩条。
- **Don't** 为风格重新发明标准控件。按钮、表单、表格、弹窗、导航和底部 sheet 必须保持熟悉的产品交互。
- **Don't** 让文本溢出容器。中英文、移动端、安全区和折叠侧栏都必须纳入布局检查。
