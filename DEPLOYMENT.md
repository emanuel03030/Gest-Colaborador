# 🚀 Guia de Deployment - Sistema de Gestão de Colaboradores

Este documento descreve como colocar o sistema em produção em diferentes ambientes.

## 📋 Índice

1. [Desenvolvimento Local](#desenvolvimento-local)
2. [Deployment Profissional](#deployment-profissional)
3. [Plataformas Recomendadas](#plataformas-recomendadas)
4. [Configuração de Segurança](#configuração-de-segurança)
5. [Troubleshooting](#troubleshooting)

---

## Desenvolvimento Local

### Pré-requisitos

- Node.js 18+
- npm ou yarn

### Setup

```bash
# 1. Instale as dependências do backend
cd backend
npm install

# 2. Configure variáveis de ambiente (opcional)
# Copie .env.example para .env e ajuste se necessário
cp .env.example .env

# 3. Inicie o servidor
npm start

# Servidor rodando em: http://localhost:3001
```

### Acesse o sistema

- **Login:** http://localhost:3000 (via Live Server ou similar)
- **API:** http://localhost:3001

Credenciais padrão:
```
Usuário: FRANCISCO.C
Senha:   7792
```

---

## Deployment Profissional

### Arquitetura Recomendada

```
┌─────────────────────────────────────────┐
│      Cliente (Frontend + SDKs)          │
│  ├─ index.html                          │
│  ├─ login.html                          │
│  ├─ config.js (configura API_URL)       │
│  ├─ sdk/data_sdk.js                     │
│  └─ sdk/element_sdk.js                  │
└──────────────┬──────────────────────────┘
               │ HTTPS
┌──────────────▼──────────────────────────┐
│   Backend (Node.js + Express + SQLite)  │
│  ├─ /api/auth/* (autenticação)          │
│  ├─ /api/records/* (CRUD de dados)      │
│  ├─ /api/events (SSE - sincronização)   │
│  └─ database.sqlite (dados)             │
└─────────────────────────────────────────┘
```
          
Publique também o arquivo `sdk/img/Logomarca - site.jpeg`, utilizado como favicon
por `index.html` e `login.html`.

### Passos para Produção

#### 1. Prepare o Backend

```bash
cd backend

# Instale dependências
npm install

# Configure variáveis de ambiente
cat > .env << EOF
PORT=3001
NODE_ENV=production
DB_FILE=./database.sqlite
ALLOWED_ORIGINS=https://seudominio.com,https://www.seudominio.com
ALLOW_SELF_REGISTER=false
AUTH_WINDOW_MS=600000
AUTH_MAX_ATTEMPTS=10
EOF

# Teste localmente
npm start
```

#### 2. Configure o Frontend

O frontend se configura **automaticamente** via `config.js`:

- **Desenvolvimento local:** detecta `http://localhost:3001`
- **Produção:** usa o mesmo domínio/porta do frontend

Se precisar de URL customizada, defina antes de carregar o config:

```html
<script>
  window.API_BASE_URL = 'https://api.seudominio.com';
</script>
<script src="config.js"></script>
```

#### 3. Servidor Web (Nginx/Apache)

**Nginx (recomendado):**

```nginx
server {
    listen 443 ssl http2;
    server_name seudominio.com www.seudominio.com;

    ssl_certificate /etc/ssl/certs/seu_cert.crt;
    ssl_certificate_key /etc/ssl/private/sua_key.key;

    # Frontend
    location / {
        root /var/www/portfolio/;
        try_files $uri $uri/ /index.html;
        index index.html;
    }

    # API
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Headers de segurança
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SSE (Server-Sent Events)
    location /api/events {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }

    # Health check
    location /health {
        proxy_pass http://localhost:3001;
    }
}
```

---

## Plataformas Recomendadas

### 🌐 Railway.app (Recomendado - Mais fácil)

**Vantagens:** Deploy automático via Git, banco SQLite suportado, domínio grátis

1. **Prepare o repositório:**
```bash
# Adicione Procfile na raiz do projeto
echo "web: cd backend && npm start" > Procfile
```

2. **Configure variáveis no Railway Dashboard:**
```
PORT: 3001
NODE_ENV: production
ALLOWED_ORIGINS: https://seu-app.up.railway.app
```

3. **Deploy:**
- Conecte seu repositório Git ao Railway
- Clique "Deploy"
- Acesse `https://seu-app.up.railway.app`

### 🎯 Render.com

**Semelhante ao Railway, com mais controle**

1. Crie novo Web Service
2. Selecione repositório
3. Build command: `cd backend && npm install`
4. Start command: `npm start`
5. Configure variáveis de ambiente
6. Deploy

### ☁️ AWS/Digital Ocean

Para ambientes mais complexos com escalabilidade:

```bash
# Backend em VM
ssh user@seu-server
cd /opt/portfolio
git pull
cd backend
npm install
pm2 start server.js

# Frontend em S3 + CloudFront (AWS) ou similar
# Ou em nginx/apache na mesma VM
```

### 🐳 Docker (Opcional - Para maior controle)

**Dockerfile:**
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Backend
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm install

# Frontend
COPY . .

EXPOSE 3001

CMD ["node", "backend/server.js"]
```

**Deploy:**
```bash
docker build -t portfolio .
docker run -p 3001:3001 -e NODE_ENV=production portfolio
```

---

## Configuração de Segurança

### 1. HTTPS Obrigatório

Em produção, **sempre use HTTPS**:

```javascript
// No backend, redirecione HTTP → HTTPS
const express = require('express');
const app = express();

app.use((req, res, next) => {
  if (req.header('x-forwarded-proto') !== 'https') {
    res.redirect(`https://${req.header('host')}${req.url}`);
  }
  next();
});
```

### 2. CORS Configurado

```bash
# No .env
ALLOWED_ORIGINS=https://seudominio.com,https://www.seudominio.com
```

❌ **Nunca use** `ALLOWED_ORIGINS=*` em produção!

### 3. Rate Limiting

Já implementado para autenticação (10 tentativas em 10 minutos).

### 4. Database Backup

O backend agora pode criar backups consistentes do SQLite usando o backup online,
incluindo bancos em modo WAL. Cada arquivo é criptografado com AES-256-GCM e a
retenção padrão é de 30 dias.

Configure no `backend/.env` (use uma chave longa e aleatória, guardada fora do Git):

```env
BACKUP_ENABLED=true
BACKUP_DIR=./backups
BACKUP_INTERVAL_MS=86400000
BACKUP_RETENTION_DAYS=30
BACKUP_ENCRYPTION_KEY=coloque-aqui-uma-chave-secreta-longa
```

Para criar um backup manual:

```bash
cd backend
npm run backup
```

Para restaurar em um arquivo separado e validar antes de substituir o banco ativo:

```bash
npm run restore -- ./backups/database-AAAA-MM-DDTHH-MM-SS-mmmZ.sqlite.enc ./database-restored.sqlite
```

Copie periodicamente `backend/backups/` para outro disco ou armazenamento externo.
Um backup apenas no mesmo computador não protege contra falha do disco ou ransomware.

### 5. Senha Padrão

⚠️ Mude as senhas padrão em produção:

```bash
# No backend/server.js, altere:
const DEFAULT_USERS = {
  'USUARIO.NOVO': 'senha_segura_123',
  // ...
};
```

---

## Troubleshooting

### "Servidor de autenticação indisponível"

**Causa:** Backend não está rodando

**Solução:**
```bash
cd backend
npm install
npm start

# Verifique: curl http://localhost:3001/health
```

### API retorna erro de CORS

**Causa:** `ALLOWED_ORIGINS` não inclui o domínio do frontend

**Solução:**
```bash
# .env
ALLOWED_ORIGINS=https://seudominio.com,https://www.seudominio.com
# Restart backend
```

### Dados não sincronizam entre abas

**Causa:** SSE ou localStorage desabilitado

**Solução:**
- Verifique que localStorage não está em modo privado/incógnito
- Confirme que `/api/events` está acessível

### Erro ao fazer deploy

**Verifique:**
```bash
# 1. Node.js versão
node --version  # deve ser 18+

# 2. npm install funcionou
cd backend && npm install

# 3. Variáveis de ambiente
cat .env

# 4. Porta aberta
netstat -an | grep 3001
```

---

## URLs de Exemplo

### Desenvolvimento
- Frontend: `http://localhost:5500` (Live Server)
- Backend: `http://localhost:3001`
- API: `http://localhost:3001/api/records`

### Produção
- Frontend: `https://seudominio.com`
- Backend: `https://seudominio.com` (mesmo domínio via proxy)
- API: `https://seudominio.com/api/records`

---

## Suporte

Para dúvidas ou problemas:
1. Consulte os logs: `npm start` (desenvolvimento)
2. Verifique o Console do navegador (F12)
3. Teste conectividade: `curl http://localhost:3001/health`

---

**Última atualização:** 2026-06-15
