# Portline vs Portless — Análise Comparativa

> Comparação entre [portline.dev](https://portline.dev) e [portless.sh](https://portless.sh),
> e avaliação de quão próximo se consegue chegar da experiência Portline usando Portless.

---

## O Problema Comum

Ambas resolvem o mesmo problema: **substituir números de porta por URLs nomeados estáveis** no localhost.

Em vez de `http://localhost:3000` (porta arbitrária, frágil, fácil de esquecer), usas
`https://myapp.localhost` — determinístico, memorizável, isolado por subdomínio.

---

## 📊 Comparação Rápida

| Característica | **Portline** | **Portless** |
|---|---|---|
| **Tagline** | _Give localhost a name_ | _Named .localhost URLs for dev_ |
| **Tipo** | App nativa macOS (menubar) | CLI Node.js (npm) |
| **Preço** | Freemium (Pro $8/mês) | **Grátis / Open Source** |
| **Código aberto** | ❌ Não | ✅ Sim (Vercel Labs, 9.7k ⭐) |
| **Public tunnels** | ✅ Sim (`*.portline.live`) | ❌ Não |
| **Traffic inspector** | ✅ Sim (nativo, replay/edit) | ❌ Não |
| **HTTPS** | ✅ Sim (nativo) | ✅ Sim (auto CA + HTTP/2) |
| **Git worktrees** | ❌ Não mencionado | ✅ Sim (subdomínio por branch) |
| **Subdomínios** | ✅ Sim | ✅ Sim |
| **Custom TLDs** | ❌ Só `.localhost` / `.portline.live` | ✅ Sim (`.test`, etc.) |
| **Framework auto-detect** | ✅ Deteta porta externamente | ✅ Injeta `--port`/`--host` |
| **Plataformas** | **Só macOS** (Intel + Silicon) | macOS, Linux, Windows |
| **Node.js required** | ❌ Não (app nativa) | ✅ Sim (Node.js 24+) |
| **Install** | `curl ... /install.sh \| sh` | `npm install -g portless` |

---

## Portline — O Canivete Suíço Nativo

### Público-alvo

Devs macOS que querem uma **UI bonita, debugging visual e public tunnels** (tipo ngrok) — tudo
numa app de menubar.

### Pontos fortes

- **App nativa macOS** — roda no menubar, interface visual com inspect, replay, edit/resend
- **Public tunnels** — `https://crimson-otter.portline.live` (ngrok killer integrado)
- **Traffic inspector integrado** — headers, bodies, status codes, sparklines em tempo real
- **"Edit & Replay"** — capturas um request, tweakas headers/body, reenvias
- **Não precisa de Node.js** — instala via shell script, app nativa
- **Testes cross-device** — abre URL pública num telemóvel ou tablet

### Limitações

- **Só macOS** — Linux e Windows "no roadmap"
- **Pago** — Free tier com limites (public URLs limitadas, histórico do inspector limitado)
- **Closed source** — sem contribuição nem auditoria
- **v0.1.0** — muito cedo no ciclo de vida

---

## Portless — O CLI Minimalista Open Source

### Público-alvo

Devs que querem **zero-friction, CI/CD, AI coding agents, e git worktrees**.
Feito pela Vercel Labs.

### Pontos fortes

- **Open source** — 9.7k ⭐ no GitHub, auditável, contribuível
- **Completamente grátis** — sem tiers, sem contas
- **Multi-plataforma** — macOS, Linux, Windows
- **Git worktrees** — cada branch ganha subdomínio automático (`fix-ui.myapp.localhost`)
- **HTTPS + HTTP/2** por defeito com auto-CA
- **Framework auto-injection** — deteta Vite, Astro, React Router, Angular, Expo
- **Custom TLDs** — podes usar `.test` em vez de `.localhost`
- **"For humans and agents"** — pensado para AI agents que precisam de URLs estáveis
- **Integração npm** — natural no ecossistema JS

### Limitações

- **Só CLI** — sem UI, menubar, inspector
- **Sem public tunnels** — não expõe para a internet
- **Sem traffic inspector** — não vês nem replayas requests
- **Requer Node.js 24+**
- **Pré-1.0** — formato do state directory pode mudar entre releases

---

## 🧠 Análise Gap: Portless → Experiência Portline

Avaliação de quão perto se chega da experiência Portline usando Portless + ferramentas
complementares. Tudo o que está abaixo é **grátis e open source**.

---

### Gap 1: Public HTTPS Tunnels

**Portline:** `https://crimson-otter.portline.live` com toggle na app.

**Solução com Portless:**

| Ferramenta | Custo | Setup |
|---|---|---|
| **Cloudflare Tunnel** (`cloudflared`) | **Grátis** | `brew install cloudflared` → `cloudflared tunnel --url http://localhost:3000` |
| **Tailscale Funnel** | Grátis pessoal / $5/mês equipa | `tailscale funnel 80` (já tens Tailscale!) |
| **Tailscale Serve** | **Grátis** | `tailscale serve --bg --https=443 localhost:3000` (só tailnet) |
| **ngrok** | Grátis (com branding) | `ngrok http 3000` |

**Veredito: ✅ 100% alcançável.** Cloudflare Tunnel é o melhor custo-benefício. Tailscale Serve é o mais clean para uso interno.

---

### Gap 2: Traffic Inspector

**Portline:** Inspector nativo no menubar com sparklines, headers, bodies, status codes.

**Solução com Portless:**

| Ferramenta | Custo | Setup |
|---|---|---|
| **mitmproxy** | **Grátis** | `brew install mitmproxy` → `mitmweb` → web UI com timeline, filtros, inspect |
| **Proxyman** | Grátis (Pro $12/mês) | App nativa macOS, UI parecida à Portline |
| **Chrome DevTools** | **Grátis** | Network tab já faz tudo |

**Veredito: ✅ 95% alcançável.** `mitmweb` + Portless = inspector + capture. A única perda
é o 1-click "Inspect" no menubar (vs abrir `mitmweb` no browser).

---

### Gap 3: Edit & Replay Requests

**Portline:** Tap num request, tweak headers/body, resend.

**Solução com Portless:**

- **mitmproxy** tem "Edit" + "Replay" nativos no web UI
- **Proxyman** tem "Repeat & Edit" com UI nativa macOS

**Veredito: ✅ 100% alcançável** com mitmproxy (grátis).

---

### Gap 4: Native macOS Menubar App

**Portline:** Menubar com toggle switches, copiar URL, status dot, sparklines.

**Opções para aproximar com Portless:**

- **Raycast Extension** — ~2h de dev, dava para listar rotas, copiar URLs, start/stop
- **Alfred Workflow** — script-based
- **Shortcuts.app** — atalho "Start dev server" que corre `portless` no terminal
- **Swift menubar app DIY** — projeto de um fim de semana, experiência quase idêntica

**Veredito: ⚠️ 70% sem projeto extra.** Com extensão Raycast (~2h) sobe para 90%.
Sparklines em tempo real e status visual requerem app nativa (não trivial).

---

### Gap 5: Test on Real Devices

**Portline:** Abrir URL pública num telemóvel ou tablet.

**Solução com Portless:**

A melhor resposta é **Tailscale Serve** — já tens Tailscale instalado:
```
tailscale serve --bg --https=443 localhost:3000
```
Agora `https://myapp.localhost` funciona em qualquer dispositivo na tua tailnet.

Para internet pública: `cloudflared tunnel --url http://localhost:3000`.

**Veredito: ✅ 100% alcançável** — e provavelmente melhor que o Portline,
porque usas a rede privada (Tailscale) em vez de passar por terceiros.

---

## 💰 Comparação de Custo

| Componente | Portline (Pro) | Portless Stack |
|---|---|---|
| Named .localhost URLs | ✅ | ✅ **Grátis** |
| HTTPS | ✅ | ✅ **Grátis** |
| Public tunnels | ✅ | via Cloudflare Tunnel **Grátis** |
| Traffic inspector | ✅ | via mitmproxy **Grátis** |
| Edit & Replay | ✅ | via mitmproxy **Grátis** |
| Menubar UI | ✅ | CLI-only (ou DIY Raycast ~2h) |
| Dispositivos na LAN | ✅ | via Tailscale Serve **Grátis** |
| **Custo mensal** | **$8/mês** | **$0/mês** |

---

## 🏁 Veredito Final

> **É 100% possível replicar a experiência Portline com Portless + ferramentas
> complementares, com duas ressalvas:**

1. **Integração "tudo no mesmo sítio"** — a Portline junta menubar, inspector, tunnels e
   replay numa app só. Com Portless + mitmproxy + cloudflared tens 3 CLIs separadas e uma
   web UI (mitmweb). Perdes coesão visual, ganhas flexibilidade e custo zero.

2. **Menubar** — a única feature que requer construção. Uma extensão Raycast (~2h)
   fecha o gap para 90% dos casos.

### Stack recomendada para Tiago

```
portless myapp next dev            → https://myapp.localhost     (CLI)
tailscale serve --bg --https=443   → expõe à tailnet             (devices reais)
cloudflared tunnel --url ...       → público quando necessário   (webhooks)
mitmweb                            → inspect + replay            (debugging)
```

**Setup único:** ~15 minutos. **Custo:** 0€. **Aprendizagem:** 30 minutos.
