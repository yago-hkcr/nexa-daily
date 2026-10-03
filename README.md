# NEXA Daily — Terminal Cyberpunk de Produtividade

Checklist e gerenciador de tarefas de alta performance, com estética cyberpunk, gamificação e segurança reforçada. **Zero dependências externas** — precisa apenas do **Node.js 18+**.

---

## ⚡ Novos Recursos & Superpoderes

### 🎮 1. Sistema de Gamificação & Ranks Netrunner
- **Ganho de XP em tempo real:** Concluir tarefas e subtarefas concede experiência com base na prioridade (Urgente = +50 XP, Alta = +35 XP, etc.).
- **Títulos e Ranks Cibernéticos:** Evolua do rank `LVL 1: Iniciado Cyber` até `LVL 10: Ghost in the Shell`.
- **Ofensiva / Streak Diário (🔥):** Monitore seus dias consecutivos de produtividade.

### ⏱️ 2. Matrix Overclock (Modo Foco Pomodoro)
- Timer integrado com display digital cyberpunk (25 min, 50 min ou 5 min de recarga).
- Vincule a sessão a uma tarefa específica da sua lista.
- Concluir uma sessão de foco rende **+30 XP** e emite alerta sonoro no final.
- Atalho rápido: tecle `F`.

### ☷ 3. Visualização Dupla: Lista ou Quadro Kanban
- Alterne instantaneamente entre visualização em **Lista Clássica** e **Quadro Kanban**.
- 3 Colunas: **A Fazer**, **Em Foco / Andamento** e **Concluídas**.
- Botões de movimentação rápida entre colunas diretamente no card.
- Atalho rápido: tecle `K`.

### 📋 4. Subtarefas & Checklists Aninhadas
- Cada tarefa pode ter passos/sub-itens próprios.
- Barra de progresso visual percentual (`2/4 concluídos • 50%`).
- Campo inline para adicionar novos passos rapidamente (`+ Passo`).

### 📌 5. Fixação de Tarefas (Pin)
- Destaque objetivos cruciais com a flag `📌 FIXADA` e borda de pulso neon cyan.
- Tarefas fixadas permanecem no topo da lista ou do Kanban.

### 🚀 6. Gerador de Daily Standup (Markdown)
- Com 1 clique, gere o resumo do seu dia formatado em Markdown para reuniões e reports (Slack, Discord, WhatsApp).
- Atalho rápido: tecle `S`.

### 🔊 7. Sintetizador de Áudio Cyberpunk (Nativo)
- Feedback sonoro com sintetizador direto na Web Audio API (sem arquivos MP3 pesados).
- Efeitos sonoros para conclusão de tarefa, subida de nível, exclusão e alarme de foco.
- Botão de Mute/Som no menu lateral ou atalho `M`.

### ⌨️ 8. Atalhos de Teclado Nerds
Pressione `?` para abrir a cola a qualquer momento:
- `N` → Nova tarefa rápida
- `/` → Focar no campo de busca
- `F` → Abrir cronômetro de Foco
- `K` → Alternar entre Lista e Kanban
- `S` → Gerar relatório Daily Standup
- `M` → Ligar / Desligar som
- `Esc` → Fechar janelas / modais

---

## 🚀 Como Rodar

1. No terminal do projeto, execute:
   ```bash
   node server.js
   ```
2. Na primeira execução, o terminal exibe o e-mail e a senha inicial do **dono**.
3. Abra no navegador: **`http://127.0.0.1:3000`**

---

## 🔒 Segurança & Controle de Acesso
- **Zero confiança:** Novos usuários criam uma solicitação de acesso que só pode ser aprovada pelo dono no painel de Administração.
- **Criptografia:** Senhas com scrypt + salt individual de 64 bytes.
- **Sessões blindadas:** Cookie `HttpOnly` com flag `SameSite=Strict`.
- **Proteções ativas:** Rate limit por IP, bloqueio contra força bruta, proteção contra CSRF via cabeçalhos de origem e CSP estrita.

