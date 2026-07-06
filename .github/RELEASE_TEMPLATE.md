# English

**Open-source build, not paid-signed.** macOS and Windows may ask you to confirm on first launch. Linux AppImage downloads may need executable permission — instructions below.

## What's changed

### Added
- **Japanese and Korean interface languages:** Settings -> General -> Interface language now includes 日本語 and 한국어, and Auto (system) recognizes Japanese and Korean system locales. (#57, #58)
- **Linux AppImage downloads:** Linux x64 AppImage is now available alongside macOS and Windows builds. (#65)

### Improved
- **Dashboard stat cards:** Activity summary cards now balance their widths so longer localized labels and values fit more evenly.
- **Bundled tokscale 4.0.11:** Includes Oh My Pi (OMP) usage tracking and ZCode parsing fixes. (#77)

### Fixed
- **App update prompts:** Dismissing one release no longer hides later releases for a full day; cached newer versions are refreshed more quickly.

## Which file should I download?

- **macOS (Apple Silicon, M1 and later)** — the `.dmg` file
- **Windows 10/11** — `Token Monitor Setup ….exe` (installer, recommended)
- **Windows portable** — `Token Monitor ….exe` (runs without installing)
- **Linux x64** — the `.AppImage` file

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

## First-launch unlock

**macOS:** right-click `Token Monitor.app` → Open (once). If you see "Token Monitor" can't be opened or is damaged:

```bash
xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"
```

**Windows:** SmartScreen → More info → Run anyway.

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

## tokscale dependency

Tokscale is bundled with this app. See **Settings → Tokscale** for the exact version
and the option to download a newer version directly from npm. Tokscale is MIT,
open-source: https://github.com/junhoyeo/tokscale

---

# 中文

**这是开源构建，不是付费签名版本。** macOS 和 Windows 首次启动时可能会要求你手动确认；Linux AppImage 下载后可能需要先赋予执行权限，操作说明见下方。

## 更新内容

### 新增
- **日文和韩文界面：** 设置 -> 常规 -> 界面语言 现在包含 日本語 和 한국어，自动（跟随系统）也会识别日文、韩文系统语言。（#57、#58）
- **Linux AppImage 下载：** 现在会和 macOS、Windows 一起提供 Linux x64 AppImage。（#65）

### 改进
- **仪表盘统计卡片：** 活动摘要卡片现在会平衡宽度，较长的本地化标签和值也更容易排布整齐。
- **内置 tokscale 4.0.11：** 包含 Oh My Pi (OMP) 用量追踪和 ZCode 解析修复。（#77）

### 修复
- **应用更新提示：** 忽略某个版本后，后续新版本不会再被整天隐藏；已缓存的新版本会更快刷新。

## 应该下载哪个文件？

- **macOS（苹果芯片，M1 及之后机型）** — 下载 `.dmg` 安装包
- **Windows 10/11** — 下载 `Token Monitor Setup ….exe`（安装版，推荐）
- **Windows 便携版** — 下载 `Token Monitor ….exe`（无需安装，直接运行）
- **Linux x64** — 下载 `.AppImage` 文件

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

## 首次启动放行

**macOS：** 右键 `Token Monitor.app` → 打开（只需要一次）。如果看到「Token Monitor」未开启 或 已损坏：

```bash
xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"
```

**Windows：** SmartScreen → 更多信息 → 仍要运行。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

## tokscale 依赖

Tokscale 已随应用内置。你可以在 **设置 → Tokscale** 查看确切版本，
也可以直接从 npm 下载更新版本。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale
