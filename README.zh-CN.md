<div align="center">

# ✨ Magic Resume ✨

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
![TanStack Start](https://img.shields.io/badge/TanStack_Start-latest-black)
![Framer Motion](https://img.shields.io/badge/Framer_Motion-10.0-purple)

<a href="https://trendshift.io/repositories/13077" target="_blank"><img src="https://trendshift.io/api/badge/repositories/13077" alt="Magic Resume | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>


简体中文 | [English](./README.md)

</div>

Magic Resume 是一个现代化的在线简历编辑器，让创建专业简历变得简单有趣。基于 TanStack Start 和 Motion 构建，支持实时预览和自定义主题。

## 📸 项目截图

<img width="1920" height="1440" alt="85_1x_shots_so" src="https://github.com/user-attachments/assets/4667e49a-7bf2-4379-9390-725e42799dc7" />


## ✨ 特性

- 🚀 基于 TanStack Start 构建
- 💫 流畅的动画效果 (Motion)
- 🎨 自定义主题支持
- 🌙 深色模式
- 📤 导出为 PDF
- 🔄 实时预览
- 💾 自动保存
- 🔒 硬盘级存储

## 🛠️ 技术栈

- TanStack Start
- TypeScript
- Motion
- Tiptap
- Tailwind CSS
- Zustand
- Shadcn/ui
- Lucide Icons

## 🚀 快速开始

1. 克隆项目

```bash
git clone git@github.com:JOYCEQL/magic-resume.git
cd magic-resume
```

2. 安装依赖

```bash
pnpm install
```

3. 启动开发服务器

```bash
pnpm dev
```

4. 打开浏览器访问 `http://localhost:3000`

## ☁️ WebDAV 同步

打开**设置 → WebDAV 同步**，填写 WebDAV 服务器 URL、用户名和密码。远程目录可配置，默认为 `/magic-resume/`。选择**立即同步**可手动同步。新建 WebDAV 配置默认开启自动同步；已有配置中明确保存的开关值会原样保留。

每份简历分别存储在配置的远程根目录下：

```text
<remote-root>/
├── manifest.json
├── objects/<full-resume-id>/<content-hash>.json
├── resumes/<safe-title>--<short-id>.json
└── trash/<safe-title>--<short-id>.json
```

`resumes/` 和 `trash/` 中的文件与手动导出格式一致，可以逐个导入。`objects/` 是不可变的事实来源，易读的简历与回收站文件则是镜像。

如果本地副本和云端副本自上次成功同步后都发生了变化，应用会报告冲突，并让你明确选择**使用本地版本**（上传本地副本）或**使用云端版本**（替换本地数据）。Magic Resume 不会自动合并单份简历。

使用坚果云时，服务器 URL 填写 `https://dav.jianguoyun.com/dav/`，用户名填写坚果云账号邮箱，密码必须填写**第三方应用密码**（不是账号登录密码）。由于坚果云不允许浏览器直接跨域访问，Magic Resume 会通过固定上游的妙笔 API FaaS 代理转发坚果云流量。凭据仍保存在浏览器中，仅随每次代理请求转发，FaaS 不会持久化凭据；浏览器 CSP 不单独加入坚果云域名。

其他 WebDAV 服务仍由浏览器直接连接，简历数据和凭据不会经过 Magic Resume 应用服务器，因此服务端必须通过 CORS 允许应用使用的 WebDAV 方法和请求头。在妙笔部署中，静态应用资源来自配置的 GitHub Pages graph origin，应用 API 请求固定使用当前妙笔 API origin，`connect-src https:` 则保留给这些非坚果云 WebDAV 的浏览器直连。远程文件是明文 JSON，传输过程由 HTTPS 保护，Magic Resume 不提供静态加密。当应用通过 HTTPS 提供服务时，请使用 HTTPS WebDAV 端点；只有在 localhost 本地开发期间才支持纯 HTTP。

WebDAV 设置和凭据会存储在此浏览器的本地存储中。同一浏览器配置中的其他脚本、扩展程序或用户可能读取这些信息。建议使用仅限所配置目录、遵循最小权限原则的专用 WebDAV 账号，并避免在共享或不受信任的设备上启用同步。清除已保存的凭据只会断开此浏览器的连接，不会删除任何远程文件。

## 📦 构建打包

```bash
pnpm build
```

### 妙笔原生部署

运维人员需安装并登录 `gh` 与 `magic-builder` 1.3.0 或更高版本，使用已评审 commit，并确保 `fork` 的唯一 push URL 指向 `aurostars/magic-resume`。GitHub Pages 必须公开，并从 `gh-pages` 分支根目录发布。执行前先检查：

```bash
gh auth status
git remote get-url --push --all fork
export MIAOBI_GIT_COMMIT="$(git rev-parse HEAD)"
corepack pnpm build:miaobi
corepack pnpm deploy:miaobi
```

部署会对 GitHub Pages 发布、Pages 健康检查、每次 FaaS 操作、固定页面切换和不可变状态提交执行 generation fencing；远端页面结果无法确认时以 `MIAOBI_PAGE_RESULT_UNCERTAIN` 关闭失败，绝不能自动重试或覆盖。

简历和 WebDAV 凭据仍位于当前浏览器 profile。坚果云凭据仅随每次请求通过固定上游的 API FaaS 转发，FaaS 永不持久化；其他 WebDAV 服务仍由浏览器直连。凭据不会迁入 GitHub Pages。Pages 使用不可变、内容寻址 release，运维需监控仓库存储增长，清理只能走单独评审的保留策略。此前因发布受阻而放弃的 TOS 路径仅保留历史说明，不属于默认部署。Cloudflare 仅作为人工回滚路径保留，不参与妙笔运行时。[妙笔原生部署指南（中文为主 / English summary）](docs/miaobi-deployment.md)是首次 Pages 启用、运行时域名、状态恢复、回滚与验证限制的权威说明。

### AI 厂商网络配置

Cloudflare Workers 使用平台原生 `fetch`，无需配置应用层代理。Node.js 或 Docker 部署在无法直连 OpenAI、Gemini、Anthropic 的地区时，可以设置 `AI_PROXY_URL`；同时兼容 `HTTPS_PROXY` 和 `HTTP_PROXY`。

```bash
AI_PROXY_URL=http://127.0.0.1:7890
```

DeepSeek、通义千问和豆包保持直连。

## 🐳 Docker 部署

### Docker Compose

1. 确保你已经安装了 Docker 和 Docker Compose

2. 在项目根目录运行：

```bash
docker compose up -d
```

这将会：

- 自动构建应用镜像
- 在后台启动容器



## 📝 许可协议与使用限制

本项目源代码基于 **Apache 2.0** 协议发布，并附带**仅限非商业使用**的额外限制：

- **个人免费**：仅限个人非商业目的（如个人学习交流、制作个人简历）免费使用。
- **禁止商用**：不得将本项目用于任何商业目的，包括将其作为收费或营利性服务（如 SaaS/PaaS）对外提供、用于企业商业运营、转售或进行二次商业化开发，**无论是否修改源代码**。

详情请查看 [LICENSE](LICENSE) 文件。

## 🗺️ 路线图

- [x] AI 辅助编写
- [x] 多语言支持
- [ ] 支持更多简历模板
- [x] 更多格式导出
- [x] 自定义模型
- [x] 自动一页纸
- [x] 导入 PDF, Markdown 等
- [ ] 在线简历托管

## 📈 Star History

<a href="https://star-history.com/#JOYCEQL/magic-resume&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=JOYCEQL/magic-resume&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=JOYCEQL/magic-resume&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=JOYCEQL/magic-resume&type=Date" />
 </picture>
</a>

## 📞 联系方式

可以通过以下方式关注最新动态:

- 作者：SiYue
- X: @GuangzhouY81070
- Discord: 欢迎加入群组 https://discord.gg/9mWgZrW3VN
- 邮箱：18806723365@163.com
  

- 项目主页：https://github.com/JOYCEQL/magic-resume

## 🌟 支持项目

<img src="https://github.com/JOYCEQL/picx-images-hosting/raw/master/pintu-fulicat.com-1741081632544.26lmg2uc2m.webp" width="320"  alt="图片描述">

## ❤️ 赞助名单

<div align="center">
  <h3>Sponsors</h3>
  <p>如果您赞助了本项目，但没展示在这里，请联系我。</p>
  <p>
    <a href="https://github.com/yj147">
      <img src="https://github.com/yj147.png?size=40" width="40" height="40" alt="@yj147" />
    </a>
    <a href="https://github.com/someone1128">
      <img src="https://github.com/someone1128.png?size=40" width="40" height="40" alt="@someone1128" />
    </a>
    <!-- 在这里继续添加赞助者：
    <a href="https://github.com/<username>">
      <img src="https://github.com/<username>.png?size=40" width="40" height="40" alt="@<username>" />
    </a>
    -->
  </p>
</div>
