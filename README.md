# Stream Player (Diego-Flix)

Um projeto de streaming de vídeo local ("mini Jellyfin/Plex" pessoal) feito com React/Next.js no frontend e Node.js/Fastify no backend. O objetivo é ler vídeos do seu computador, extrair metadados e transmiti-los (stream) pela rede local usando conversão HLS (HTTP Live Streaming) sob demanda via FFmpeg.

## 1. Visão Geral e Arquitetura

```text
[Diretório local de vídeos]
        │
        ▼
 ┌─────────────────────────────┐
 │   Backend Node.js           │
 │  - Scanner (fs + ffprobe)   │
 │  - API REST (Fastify)       │
 │  - Transcode (FFmpeg/HLS)   │
 │  - Limpeza automática       │
 └─────────────────────────────┘
        │  HTTP (rede local)
        ▼
 ┌─────────────────────────────┐
 │  Frontend Next.js           │
 │  - Lista de arquivos        │
 │  - Player (<video> + hls.js)│
 │  - Tela de Configuração     │
 └─────────────────────────────┘
```

O projeto soluciona um problema clássico de streaming web: **arquivos MKV não rodam nativamente nos navegadores**. Mesmo que o vídeo interno seja H.264/AAC, o formato de container (Matroska) é ignorado por Chrome, Safari, Firefox, etc. 

Para resolver isso, o backend atua de três formas, dependendo do arquivo:
1. **Direct play**: Para arquivos compatíveis (como MP4 com H.264+AAC), o vídeo é servido diretamente, suportando *Range requests* sem processamento.
2. **Remux**: Troca apenas o container (ex: MKV para MP4/HLS) sem recodificar o vídeo. Extremamente rápido e de baixo custo de CPU.
3. **Transcode completo**: Para codecs incompatíveis (como HEVC ou áudios não suportados), o FFmpeg recodifica o vídeo em tempo real gerando segmentos HLS (.m3u8 + .m4s).

## 2. Funcionalidades Principais

- **Streaming HLS Adaptativo:** Transcodifica e divide vídeos grandes em pequenos pedaços na hora em que você assiste.
- **Limpeza Inteligente de Cache:** Arquivos temporários de streaming ocupam gigabytes de espaço. O backend possui uma rotina de limpeza na inicialização e apaga a pasta de cache do vídeo **imediatamente** quando o processo do FFmpeg é encerrado (por fechamento do vídeo, timeout de 30s de inatividade ou requisição explícita de parada).
- **Scanner de Biblioteca e FFprobe:** Escaneia recursivamente pastas, identificando vídeos válidos, sua duração, codecs e faixas de áudio, salvando num índice em JSON (`library.json`).
- **Navegador de Diretório (File Browser):** Como o frontend roda no cliente mas mapeia arquivos do servidor, a tela de configuração utiliza uma API que navega nas pastas da própria máquina onde o Node está rodando.

## 3. Tecnologias Utilizadas

- **Frontend:** Next.js (React), TypeScript, Tailwind CSS, `hls.js` (para tocar HLS em browsers sem suporte nativo), `swr`/React Query.
- **Backend:** Node.js, Fastify, TypeScript.
- **Processamento de Mídia:** `ffmpeg-static`, `ffprobe-static` e `fluent-ffmpeg`.

## 4. Como Executar o Projeto

Você precisa iniciar tanto o backend quanto o frontend em terminais separados.

### Iniciando o Backend

1. Abra um terminal e navegue até a pasta `backend`:
   ```bash
   cd backend
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Inicie o servidor:
   ```bash
   npm run dev
   ```
   *O backend rodará por padrão na porta `3001`. Ao iniciar, ele limpa caches residuais e escaneia os diretórios pré-configurados.*

### Iniciando o Frontend

1. Abra um novo terminal e navegue até a pasta `frontend`:
   ```bash
   cd frontend
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Inicie a aplicação Next.js:
   ```bash
   npm run dev
   ```
   *A interface estará disponível em `http://localhost:3000`.*

## 5. Pontos de Atenção e Riscos

- **Consumo de CPU:** Transcodes completos (como converter vídeos HEVC 4K para H.264 na hora) consomem bastante processamento. Em máquinas mais fracas (como uma Raspberry Pi), o ideal é manter a biblioteca em formatos compatíveis com Direct Play ou Remux.
- **Limites de Conexões:** Vários dispositivos assistindo ao mesmo tempo = vários processos do FFmpeg rodando em paralelo.
- **Legendas embutidas:** Arquivos MKV com legendas embutidas precisam ter essas faixas extraídas para `.vtt` pelo FFmpeg para o frontend renderizar corretamente na tag `<video>`.
