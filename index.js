require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const fs = require('fs');
const app = express();
const cors = require('cors')

const port = process.env.PORT || 3000;
const multer = require('multer');
const pdfParse = require('pdf-parse');
const path = require('path');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Inicializar arquivos JSON se não existirem
const contextosPath = path.join(dataDir, 'contextos.json');
const vagasPath = path.join(dataDir, 'vagas.json');

if (!fs.existsSync(contextosPath)) {
    fs.writeFileSync(contextosPath, '{}');
}

if (!fs.existsSync(vagasPath)) {
    fs.writeFileSync(vagasPath, JSON.stringify({ jobs: {} }));
}

// Aumentar o timeout para 5 minutos
app.use(express.json({ limit: '10mb', extended: true }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname))); 
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));





// Função para dividir texto em chunks menores
function dividirTextoEmChunks(texto, tamanhoMaximo = 3000) {
    // Dividir por parágrafos para manter contexto
    const paragrafos = texto.split(/\n\s*\n/);
    const chunks = [];
    let chunkAtual = '';
    
    for (const paragrafo of paragrafos) {
        // Se adicionar este parágrafo exceder o tamanho máximo
        if ((chunkAtual + paragrafo).length > tamanhoMaximo && chunkAtual.length > 0) {
            chunks.push(chunkAtual);
            chunkAtual = paragrafo;
        } else {
            chunkAtual += (chunkAtual ? '\n\n' : '') + paragrafo;
        }
    }
    
    // Adicionar o último chunk se não estiver vazio
    if (chunkAtual.length > 0) {
        chunks.push(chunkAtual);
    }
    
    return chunks;
}

// Função para processar chunks com rate limiting
async function processarChunksComRateLimit(chunks, processarFuncao) {
    const resultados = [];
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    for (let i = 0; i < chunks.length; i++) {
        try {
            console.log(`Processando chunk ${i+1}/${chunks.length}...`);
            const resultado = await processarFuncao(chunks[i]);
            resultados.push(resultado);
            
            // Adiciona um delay entre as chamadas para evitar rate limiting
            if (i < chunks.length - 1) {
                console.log('Aguardando 1 segundo antes do próximo chunk...');
                await delay(1000);
            }
        } catch (error) {
            console.error(`Erro ao processar chunk ${i+1}:`, error);
            // Adiciona um delay maior em caso de erro
            console.log('Erro detectado, aguardando 5 segundos...');
            await delay(5000);
            // Tenta novamente com um chunk menor se for erro de tamanho
            if (error.status === 413 && chunks[i].length > 1500) {
                const subChunks = dividirTextoEmChunks(chunks[i], 1500);
                console.log(`Dividindo chunk problemático em ${subChunks.length} sub-chunks menores`);
                const subResultados = await processarChunksComRateLimit(subChunks, processarFuncao);
                resultados.push(...subResultados);
            } else {
                // Se não for erro de tamanho, adiciona um placeholder
                resultados.push("Não foi possível processar esta parte do documento.");
            }
        }
    }
    
    return resultados;
}

// Função para resumir os resultados dos chunks
async function resumirResultados(resultados) {
    if (resultados.length === 1) {
        return resultados[0];
    }
    
    const resumo = resultados.join("\n\n--- Próxima Seção ---\n\n");
    
    if (resumo.length > 12000) {
        console.log("Resumo ainda é muito grande, criando meta-resumo...");
        
        try {
            const prompt = `Crie um resumo conciso e informativo do seguinte documento, mantendo os pontos principais e informações técnicas relevantes:\n\n${resumo.substring(0, 5000)}...\n\n(Documento truncado por limitações de tamanho)`;
            
            const respostaChat = await client.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: 'llama3-8b-8192',
                temperature: 0.7,
                max_tokens: 4096,
            });
            
            return respostaChat.choices[0].message.content;
        } catch (error) {
            console.error('Erro ao criar meta-resumo:', error);
            return "Não foi possível criar um resumo completo do documento devido ao seu tamanho. Considere dividir o documento em partes menores.";
        }
    }
    
    return resumo;
}

// Função modificada para melhorar o contexto com chunks
async function melhorarContextoDeChunk(chunk) {
    const prompt = `
    Analise este texto de currículo e extraia TODAS as informações possíveis, mantendo o máximo de detalhes.
    Mantenha o formato estruturado abaixo e inclua TODOS os detalhes encontrados:

    NOME_CANDIDATO: [Nome completo do candidato]

    RESUMO PROFISSIONAL:
    [Resumo detalhado do perfil profissional]

    EXPERIÊNCIA PROFISSIONAL:
    [Liste todas as experiências com máximo de detalhes]
    - Empresa:
    - Cargo:
    - Período:
    - Responsabilidades:
    - Projetos:
    - Conquistas:
    - Tecnologias utilizadas:

    FORMAÇÃO ACADÊMICA:
    [Liste todas as formações com detalhes]
    - Curso:
    - Instituição:
    - Período:
    - Trabalhos relevantes:
    - Média/Notas (se disponível):

    HABILIDADES TÉCNICAS:
    [Liste TODAS as habilidades mencionadas]
    - Hard Skills:
    - Soft Skills:
    - Nível de proficiência (quando mencionado):

    CERTIFICAÇÕES:
    [Liste todas as certificações com detalhes]
    - Nome:
    - Instituição:
    - Data/Validade:
    - Código/ID (se disponível):

    IDIOMAS:
    [Liste todos os idiomas com níveis detalhados]
    - Idioma:
    - Nível:
    - Certificações:

    PROJETOS:
    [Liste todos os projetos mencionados]
    - Nome:
    - Descrição:
    - Tecnologias:
    - Resultados:

    CONQUISTAS E REALIZAÇÕES:
    [Liste todas as conquistas profissionais e pessoais mencionadas]

    INFORMAÇÕES ADICIONAIS:
    [Qualquer outra informação relevante encontrada no currículo]
    - Disponibilidade:
    - Localização:
    - Preferências de trabalho:
    - Objetivos profissionais:
    - Links (GitHub, LinkedIn, Portfolio):
    - Publicações:
    - Palestras:
    - Participação em eventos:
    - Voluntariado:

    Texto analisado:
    ${chunk}`;
    
    const respostaChat = await client.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama3-8b-8192',
        temperature: 0.7,
        max_tokens: 4096, // Aumentado para acomodar mais conteúdo
    });

    return respostaChat.choices[0].message.content;
}

function extrairNomeDoCandidato(texto) {
    const match = texto.match(/NOME_CANDIDATO:\s*([^\n]+)/);
    return match ? match[1].trim() : null;
}

// Função melhorada para processar PDFs grandes
async function processarPDFGrande(textoCompleto) {
    console.log(`Texto extraído do PDF: ${textoCompleto.length} caracteres`);
    
    // Dividir o texto em chunks menores
    const chunks = dividirTextoEmChunks(textoCompleto);
    console.log(`Dividido em ${chunks.length} chunks`);
    
    // Processar cada chunk e obter resumos
    const resumosDeChunks = await processarChunksComRateLimit(chunks, melhorarContextoDeChunk);
    
    // Combinar os resumos em um único contexto
    const contextoFinal = await resumirResultados(resumosDeChunks);
    
    return contextoFinal;
}


// Configuração do Multer para upload de arquivos
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure uploads directory exists
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Generate unique filename with timestamp and original extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

// Filtro para aceitar apenas arquivos PDF
const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Apenas arquivos PDF são aceitos'), false);
    }
};

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 1024 * 1024 * 10 // Limite de 10MB
    },
    fileFilter: fileFilter
});

// Certifique-se de que o diretório de uploads existe
try {
    if (!fs.existsSync('./uploads')) {
        fs.mkdirSync('./uploads');
        console.log('Diretório de uploads criado.');
    }
} catch (error) {
    console.error('Erro ao criar diretório de uploads:', error);
}

// Função para extrair texto de um PDF
async function extrairTextoDePDF(caminhoArquivo) {
    try {
        const pdfBuffer = fs.readFileSync(caminhoArquivo);
        const data = await pdfParse(pdfBuffer);
        return data.text;
    } catch (error) {
        console.error('Erro ao extrair texto do PDF:', error);
        throw error;
    }
}






//teste de funcao


// Rota para extrair texto do PDF
app.post('/extrair-texto-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }

        const caminhoArquivo = req.file.path; // Apenas usar req.file.path

        const pdfBuffer = fs.readFileSync(caminhoArquivo);
        
        const data = await pdfParse(pdfBuffer);
        const textoExtraido = data.text;

        // Apagar o arquivo após a leitura
        fs.unlinkSync(caminhoArquivo);

        res.json({ texto: textoExtraido });

    } catch (error) {
        console.error('Erro ao extrair texto do PDF:', error);
        res.status(500).json({ error: 'Erro ao processar o PDF.' });
    }
});

// Função para gerenciar múltiplos contextos
async function salvarContexto(nomeArquivo, conteudo) {
    try {
        const contextos = carregarTodosContextos();
        const nomeCandidato = extrairNomeDoCandidato(conteudo);
        const conteudoLimpo = conteudo.replace(/NOME_CANDIDATO:[^\n]+\n/, '').trim();
        const categorias = await categorizarCurriculo(conteudoLimpo);

        // Gerar ID único baseado em timestamp e número aleatório
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        contextos[id] = {
            id: id, // Adicionar ID ao objeto
            nome: nomeCandidato || nomeArquivo.replace(/_/g, ' ').replace(/\.pdf$/i, ''),
            conteudo: conteudoLimpo,
            categorias: categorias,
            dataCriacao: new Date().toISOString(),
            ultimaAtualizacao: new Date().toISOString(),
            entrevistaNotas: null // Inicializar campo de notas
        };

        const dataPath = path.join(dataDir, 'contextos.json');
        fs.writeFileSync(dataPath, JSON.stringify(contextos, null, 2));
        return { success: true, id: id }; // Retornar o ID gerado
    } catch (error) {
        console.error('Erro ao salvar contexto:', error);
        return { success: false, error: error.message };
    }
}

// Função para carregar o contexto do arquivo de texto
function carregarContexto() {
    try {
        if (!fs.existsSync('./contexto.txt')) {
            fs.writeFileSync('./contexto.txt', 'Você é um assistente de programação.');
            console.log('Arquivo de contexto criado com configuração padrão.');
        }
        return fs.readFileSync('./contexto.txt', 'utf8');
    } catch (error) {
        console.error('Erro ao manipular arquivo de contexto:', error);
        return 'Você é um assistente de programação.';
    }
}

// Função para gerenciar o tamanho do histórico
function gerenciarHistorico(novaMsg) {
    if (conversationHistory.length >= MAX_HISTORY * 2) {
        const contextoInicial = conversationHistory[0];
        conversationHistory = [contextoInicial];
    }
    conversationHistory.push(novaMsg);
}

// Função para carregar todos os contextos como um único texto
function carregarTodosContextosParaChat() {
    try {
        const contextos = carregarTodosContextos();
        // Combinar todos os contextos em um texto estruturado
        const contextoCombinado = Object.entries(contextos).map(([id, dados]) => {
            const nome = dados.nome || id;
            const conteudo = dados.conteudo || '';
            return `CURRÍCULO DE: ${nome}\n\n${conteudo}`;
        }).join('\n\n=== PRÓXIMO CURRÍCULO ===\n\n');
        
        return contextoCombinado || 'Nenhum currículo carregado.';
    } catch (error) {
        console.error('Erro ao carregar contextos:', error);
        return 'Erro ao carregar contextos.';
    }
}

// Rota para upload e processamento de PDFs
app.post('/upload-pdf', upload.array('pdfs', 10), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo foi enviado.' });
    }

    try {
        const resultados = [];

        for (const file of req.files) {
            console.log(`Processando ${file.originalname}...`);
            const nomeArquivo = path.parse(file.originalname).name;
            
            try {
                const textoExtraido = await extrairTextoDePDF(file.path);
                const contextoMelhorado = await processarPDFGrande(textoExtraido);
                
                // Salvar o conteúdo e obter o ID gerado
                const { success, id, error } = await salvarContexto(nomeArquivo, contextoMelhorado);
                
                if (success) {
                    resultados.push({
                        id: id, // Usar o ID gerado
                        nome: nomeArquivo,
                        resumo: contextoMelhorado.substring(0, 200) + '...',
                        arquivo: file.filename
                    });
                } else {
                    throw new Error(error || 'Erro ao salvar contexto');
                }

            } catch (processError) {
                console.error(`Erro ao processar ${file.originalname}:`, processError);
                resultados.push({
                    nome: nomeArquivo,
                    error: `Erro ao processar: ${processError.message}`
                });
            }
        }
        
        res.json({
            message: 'PDFs processados com sucesso.',
            resultados
        });
    } catch (error) {
        console.error('Erro ao processar PDFs:', error);
        // Ensure files are cleaned up in case of error
        req.files?.forEach(file => {
            try {
                fs.unlinkSync(file.path);
            } catch (unlinkError) {
                console.error('Erro ao deletar arquivo:', unlinkError);
            }
        });
        
        res.status(500).json({
            error: 'Erro ao processar os PDFs.',
            details: error.message
        });
    }
});

// Nova rota para listar currículos disponíveis
app.get('/curriculos', (req, res) => {
    try {
        const contextos = carregarTodosContextos();
        console.log('Contextos brutos:', contextos); // Debug log

        const curriculos = Object.entries(contextos).map(([id, dados]) => {
            // Check if dados is a string or object
            const conteudo = typeof dados === 'object' ? dados.conteudo : dados;
            const nome = typeof dados === 'object' ? dados.nome : id;
            const categorias = typeof dados === 'object' ? dados.categorias : null;
            const entrevistaNotas = typeof dados === 'object' ? dados.entrevistaNotas : null; // Add this line

            return {
                id: id,
                nome: nome,
                resumo: typeof conteudo === 'string' ? conteudo.substring(0, 200) + '...' : 'Sem resumo',
                categorias: categorias || {
                    areaPrincipal: 'Não categorizado',
                    areasSecundarias: [],
                    palavrasChave: []
                },
                entrevistaNotas: entrevistaNotas // Add this line
            };
        });

        console.log('Currículos processados:', curriculos); // Debug log
        res.json({ curriculos });
    } catch (error) {
        console.error('Erro ao listar currículos:', error);
        res.status(500).json({
            error: 'Erro ao listar currículos.',
            details: error.message
        });
    }
});

app.post('/comparar-curriculos', async (req, res) => {
    const { curriculos, vaga } = req.body;
    console.log('Currículos e vaga recebidos:', { curriculos, vaga });

    if (!curriculos || curriculos.length === 0) {
        return res.status(400).json({ error: 'Nenhum currículo selecionado.' });
    }

    try {
        const contextos = carregarTodosContextos();
        const vagas = carregarVagas();
        const vagaSelecionada = vaga ? vagas.jobs[vaga] : null;

        // Get job details for context
        const jobContext = vagaSelecionada ? `
            CONTEXTO DA VAGA:
            Título: ${vagaSelecionada.titulo}
            Descrição: ${vagaSelecionada.descricao}
            Requisitos: ${vagaSelecionada.requisitos}
            Nível: ${vagaSelecionada.nivel}
            Tipo: ${vagaSelecionada.tipo}
            Local: ${vagaSelecionada.local}
        ` : '';

        const curriculosSelecionados = curriculos.map(c => {
            const dados = contextos[c];
            if (!dados) {
                console.log(`Currículo não encontrado: ${c}`);
                return null;
            }
            return {
                id: c,
                nome: typeof dados === 'object' ? dados.nome : c,
                conteudo: typeof dados === 'object' ? dados.conteudo : dados
            };
        }).filter(Boolean);

        if (curriculosSelecionados.length === 0) {
            return res.status(404).json({ error: 'Nenhum currículo encontrado.' });
        }

        const prompt = `
        ${vagaSelecionada ? 'Analise os currículos considerando especificamente os requisitos da vaga:' : 'Analise os currículos e faça uma comparação geral:'}
        
        ${jobContext}
        
        ${vagaSelecionada ? `
        Importante:
        1. Priorize candidatos que atendam aos requisitos específicos da vaga
        2. Compare a experiência com o nível solicitado (${vagaSelecionada.nivel})
        3. Avalie compatibilidade com o tipo de contratação (${vagaSelecionada.tipo})
        4. Considere a localização (${vagaSelecionada.local}) na análise
        ` : ''}
        
        Currículos para análise:
        ${curriculosSelecionados.map((ctx, i) => `
        ### Candidato ${i + 1}: ${ctx.nome}
        ${ctx.conteudo}
        `).join('\n\n')}
        
        Retorne um objeto JSON com a seguinte estrutura (mantenha exatamente este formato):
        {
          "candidatos": [
            {
              "nome": "Nome exato do candidato",
              "pontosFortesResumo": "Resumo específico dos pontos fortes deste candidato",
              "pontosFortes": ["Lista", "detalhada", "dos pontos fortes"],
              "experiencias": [
                {
                  "cargo": "cargo específico",
                  "empresa": "nome da empresa",
                  "periodo": "período trabalhado",
                  "descricao": "descrição detalhada"
                }
              ],
              "habilidadesTecnicas": ["lista", "de", "habilidades"],
              "formacaoAcademica": [
                {
                  "curso": "nome do curso",
                  "instituicao": "nome da instituição",
                  "periodo": "período do curso",
                  "tipo": "tipo de formação"
                }
              ],
              "idiomas": ["Idioma - Nível"],
              "certificacoes": ["Lista de certificações"],
              "ranking": número (começando de 1),
              "justificativaRanking": "Explicação detalhada do ranking"
            }
          ],
          "analiseComparativa": "Análise detalhada comparando todos os candidatos, destacando pontos fortes e fracos de cada um",
          "recomendacaoFinal": "Recomendação clara e objetiva sobre qual candidato melhor se adequa à vaga (ou comparação geral se não houver vaga específica)"
        }`;

        const analise = await client.chat.completions.create({
            messages: [
                { 
                    role: 'system', 
                    content: 'Você é um especialista em análise de currículos. Responda APENAS com JSON válido conforme solicitado.'
                },
                { role: 'user', content: prompt }
            ],
            model: 'llama3-8b-8192',
            temperature: 0.5,
            max_tokens: 4096,
            response_format: { type: "json_object" }
        });

        try {
            const responseText = analise.choices[0].message.content.trim();
            console.log('Resposta da API:', responseText); // Debug
            
            const analiseJSON = JSON.parse(responseText);
            
            if (!analiseJSON.candidatos || !Array.isArray(analiseJSON.candidatos)) {
                throw new Error('Formato de resposta inválido');
            }
            
            res.json({ analise: analiseJSON });
        } catch (parseError) {
            console.error('Erro ao fazer parse do JSON:', parseError);
            console.error('Conteúdo recebido:', analise.choices[0].message.content);
            res.status(500).json({
                error: 'Erro ao processar resposta',
                rawResponse: analise.choices[0].message.content
            });
        }
    } catch (error) {
        console.error('Erro ao comparar currículos:', error);
        res.status(500).json({
            error: 'Erro ao comparar currículos.',
            details: error.message
        });
    }
});

// Adicione esta constante no topo do arquivo junto com as outras
const CACHE_TIMEOUT = 5 * 60 * 1000; // 5 minutos
const respostasCache = new Map();

// Adicione estas constantes no topo do arquivo
const MAX_CHUNK_SIZE = 1000; // Reduzido para 1000 caracteres
const MAX_CHUNKS_PER_REQUEST = 2; // Limita a 2 chunks por requisição
const DELAY_BETWEEN_CHUNKS = 1000; // 1 segundo entre chunks

// Adicione estas constantes no topo do arquivo
const MAX_TOKENS = 1000;
const MAX_PROMPT_LENGTH = 1500;
const MAX_CURRICULOS_PER_REQUEST = 2;

// Add these constants at the top with other constants
const MAX_HISTORY_LENGTH = 10; // Maximum number of messages to keep in history
const HISTORY_EXPIRY = 30 * 60 * 1000; // 30 minutes in milliseconds

// Add this Map to store conversation histories
const conversationHistories = new Map();

// Add function to manage conversation history
function manageConversationHistory(sessionId) {
    // Create new history if doesn't exist or expired
    if (!conversationHistories.has(sessionId) || 
        Date.now() - conversationHistories.get(sessionId).lastUpdated > HISTORY_EXPIRY) {
        conversationHistories.set(sessionId, {
            messages: [],
            lastUpdated: Date.now()
        });
    }
    return conversationHistories.get(sessionId);
}

// Add these utility functions before the chat endpoint
function extrairPalavrasChave(textos) {
    const stopWords = new Set([
        'a', 'o', 'e', 'é', 'de', 'do', 'da', 'em', 'para', 'com', 'um', 'uma',
        'os', 'as', 'dos', 'das', 'que', 'se', 'por', 'seu', 'sua', 'seus', 'suas'
    ]);

    const palavras = textos
        .filter(texto => texto) // Remove null/undefined values
        .join(' ')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove acentos
        .replace(/[^\w\s]/g, ' ') // Remove pontuação
        .split(/\s+/)
        .filter(palavra => 
            palavra.length > 2 && // Palavras com mais de 2 letras
            !stopWords.has(palavra) && // Não é stopword
            !parseInt(palavra) // Não é número
        );

    return [...new Set(palavras)]; // Remove duplicatas
}

function extrairContextoTexto(texto) {
    // Extrai segmentos relevantes do texto
    const segments = texto.match(/[^.!?]+[.!?]+/g) || [];
    return segments
        .filter(segment => segment.length > 10) // Remove segmentos muito curtos
        .join(' ')
        .slice(0, 1000); // Limita o tamanho
}

function combinarContextos(historico, curriculosRelevantes) {
    const contextoHistorico = historico.map(m => extrairContextoTexto(m.content)).join(' ');
    const contextoCurriculos = curriculosRelevantes.map(({ dados }) => 
        `${dados.nome}: ${extrairContextoTexto(dados.conteudo)}`
    ).join('\n\n');

    return {
        historico: contextoHistorico,
        curriculos: contextoCurriculos
    };
}

// Add new function to calculate historical relevance
function calcularRelevanciaHistorica(dados, mensagensHistorico) {
    let relevancia = 0;
    const ultimasMensagens = mensagensHistorico.slice(-5); // Consider last 5 messages
    
    for (const mensagem of ultimasMensagens) {
        // Extract meaningful content from the message
        const conteudo = mensagem.content.toLowerCase();
        
        // Check for name mentions
        if (dados.nome && conteudo.includes(dados.nome.toLowerCase())) {
            relevancia += 5;
        }

        // Check for area/category mentions
        if (dados.categorias?.areaPrincipal && 
            conteudo.includes(dados.categorias.areaPrincipal.toLowerCase())) {
            relevancia += 3;
        }

        // Check for skill mentions
        if (dados.categorias?.palavrasChave) {
            for (const palavra of dados.categorias.palavrasChave) {
                if (conteudo.includes(palavra.toLowerCase())) {
                    relevancia += 2;
                }
            }
        }

        // Check for interview notes mentions
        if (dados.entrevistaNotas?.texto && 
            conteudo.includes(dados.entrevistaNotas.texto.toLowerCase())) {
            relevancia += 4;
        }

        // Check content matches
        const termos = conteudo.split(/\s+/);
        for (const termo of termos) {
            if (termo.length > 3 && dados.conteudo.toLowerCase().includes(termo)) {
                relevancia += 1;
            }
        }
    }

    // Normalize relevance score
    return Math.min(relevancia, 100); // Cap at 100
}

app.post('/chat', async (req, res) => {
    const { mensagem, sessionId = Date.now().toString() } = req.body;

    if (!mensagem) {
        return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }

    try {
        const history = manageConversationHistory(sessionId);
        const contextosDisponiveis = carregarTodosContextos();

        // Extract context keywords from message and history
        const contextKeywords = extrairPalavrasChave([
            mensagem,
            ...history.messages.map(m => m.content)
        ]);

        // Get mentioned names from current message
        const nomesBuscados = extrairNomesDaPergunta(mensagem);

        // Find relevant curricula based on both history and current context
        const curriculosRelevantes = Object.values(contextosDisponiveis)
            .map(dados => {
                const relevanciaAtual = calcularRelevanciaComNome(dados, mensagem, nomesBuscados);
                const relevanciaHistorica = calcularRelevanciaHistorica(dados, history.messages);
                return {
                    dados,
                    relevancia: relevanciaAtual + relevanciaHistorica
                };
            })
            .sort((a, b) => b.relevancia - a.relevancia)
            .slice(0, 3); // Get top 3 most relevant curricula

        // Create enhanced prompt
        const prompt = `
        CONTEXTO DO SISTEMA:
        Você é um assistente especializado em análise de currículos e recrutamento.
        Use AMBOS os dados do histórico E as informações dos currículos para responder.

        HISTÓRICO DE CONVERSA RECENTE:
        ${history.messages.slice(-3).map(m => 
            `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`
        ).join('\n')}

        DADOS DOS CURRÍCULOS RELEVANTES:
        ${curriculosRelevantes.map(({ dados }) => `
        === CURRÍCULO DE ${dados.nome} ===
        Área: ${dados.categorias?.areaPrincipal || 'Não especificada'}
        Nível: ${dados.categorias?.nivel || 'Não especificado'}
        Experiência: ${extrairExperienciaRelevante(dados.conteudo)}
        Formação: ${extrairFormacao(dados.conteudo)}
        
        HISTÓRICO DE ENTREVISTAS:
        ${dados.entrevistaNotas ? formatarNotasEntrevista(dados.entrevistaNotas) : 'Sem notas de entrevista'}
        
        DETALHES COMPLETOS:
        ${dados.conteudo}
        `).join('\n\n')}

        INSTRUÇÕES DE RESPOSTA:
        1. Priorize informações dos currículos ao responder perguntas específicas sobre candidatos
        2. Use o histórico da conversa para manter contexto e consistência
        3. Seja direto e objetivo nas respostas
        4. Mencione explicitamente a fonte da informação (currículo/histórico)
        5. Se não encontrar a informação em nenhuma fonte, diga claramente

        PERGUNTA ATUAL: ${mensagem}
        `;

        // Add user message to history
        history.messages.push({ role: 'user', content: mensagem });

        const chatResponse = await client.chat.completions.create({
            messages: [
                { 
                    role: 'system', 
                    content: 'Você é um assistente de RH especializado em análise de currículos.'
                },
                { role: 'user', content: prompt }
            ],
            model: 'llama3-8b-8192',
            temperature: 0.4,
            max_tokens: 1000,
            response_format: { type: "text" }
        });

        const resposta = chatResponse.choices[0].message.content;
        history.messages.push({ role: 'assistant', content: resposta });

        // Trim history if too long
        if (history.messages.length > MAX_HISTORY_LENGTH * 2) {
            history.messages = history.messages.slice(-MAX_HISTORY_LENGTH * 2);
        }

        history.lastUpdated = Date.now();

        res.json({ 
            resposta,
            sessionId,
            historyLength: history.messages.length
        });

    } catch (error) {
        console.error('Erro ao processar mensagem:', error);
        res.status(500).json({
            error: 'Erro ao processar sua mensagem.',
            details: error.message
        });
    }
});

// Adicionar nova função para extrair nomes da pergunta
function extrairNomesDaPergunta(pergunta) {
    // Normaliza a pergunta (remove acentos e converte para minúsculas)
    const perguntaNormalizada = pergunta.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    // Padrões comuns de perguntas com nomes
    const padroes = [
        /(?:sobre|do|da|de|o|a)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)*)/i,
        /([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)*)\s+(?:tem|possui|está)/i,
        /^([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)*)/i
    ];

    const nomes = [];
    for (const padrao of padroes) {
        const match = perguntaNormalizada.match(padrao);
        if (match && match[1]) {
            nomes.push(match[1].trim());
        }
    }

    return [...new Set(nomes)]; // Remove duplicatas
}

// Adicionar nova função para calcular relevância com base no nome
function calcularRelevanciaComNome(dados, pergunta, nomesBuscados) {
    let pontos = 0;
    const nomeCompleto = dados.nome?.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    if (!nomeCompleto) return 0;

    // Remove o prefixo "**" se existir
    const nomeLimpo = nomeCompleto.replace(/^\*\*\s*/, '');
    const nomePartes = nomeLimpo.split(' ');

    // Verifica correspondência com nomes buscados
    for (const nomeBuscado of nomesBuscados) {
        // Match de nome completo
        if (nomeLimpo.includes(nomeBuscado)) {
            pontos += 100;
        }
        // Match de primeiro nome ou sobrenome
        else if (nomePartes.some(parte => 
            parte.toLowerCase() === nomeBuscado.toLowerCase())) {
            pontos += 50;
        }
        
        // Add relevance points if interview notes contain the search term
        if (dados.entrevistaNotas?.texto && 
            dados.entrevistaNotas.texto.toLowerCase().includes(nomeBuscado.toLowerCase())) {
            pontos += 25; // Give additional points for matches in interview notes
        }
    }

    // Adiciona pontos baseados na relevância geral
    pontos += calcularRelevanciaParaPergunta(dados, pergunta);

    return pontos;
}

// Função auxiliar para extrair cargo
function extrairCargo(conteudo) {
    if (!conteudo) return 'Não especificado';
    
    const cargoRegex = /(cargo atual|cargo:|função:|posição:)\s*([^,.\n]+)/i;
    const match = conteudo.match(cargoRegex);
    return match ? match[2].trim() : 'Não especificado';
}

// Função auxiliar para extrair formação
function extrairFormacao(conteudo) {
    if (!conteudo) return 'Não especificada';
    
    const formacaoRegex = /formação|graduação|curso|especialização/i;
    const match = conteudo.match(new RegExp(`.{0,100}${formacaoRegex.source}.{0,100}`, 'i'));
    
    return match ? match[0].trim() : 'Não especificada';
}

// Função auxiliar para extrair experiência relevante
function extrairExperienciaRelevante(conteudo) {
    if (!conteudo) return 'Experiência não especificada';
    
    // Busca por palavras-chave importantes no conteúdo
    const palavrasChave = ['anos de experiência', 'especialista em', 'sênior', 'pleno', 'júnior'];
    for (const palavra of palavrasChave) {
        const regex = new RegExp(`.{0,50}${palavra}.{0,50}`, 'i');
        const match = conteudo.match(regex);
        if (match) return match[0].trim();
    }
    
    return 'Experiência não especificada';
}

// Adicione estas funções auxiliares
function calcularRelevanciaParaPergunta(dados, pergunta) {
    let pontos = 0;
    const termos = pergunta.toLowerCase().split(' ').filter(t => t.length > 0);
    
    // Verifica menção direta ao nome
    if (dados.nome && pergunta.toLowerCase().includes(dados.nome.toLowerCase())) {
        pontos += 10;
    }

    // Verifica termos na área principal e secundárias
    if (dados.categorias) {
        if (dados.categorias.areaPrincipal && 
            termos.some(t => dados.categorias.areaPrincipal.toLowerCase().includes(t))) {
            pontos += 5;
        }
        if (dados.categorias.areasSecundarias) {
            dados.categorias.areasSecundarias.forEach(area => {
                if (termos.some(t => area.toLowerCase().includes(t))) {
                    pontos += 3;
                }
            });
        }
    }

    // Verifica termos no conteúdo de forma segura
    if (dados.conteudo) {
        termos.forEach(termo => {
            if (termo.length > 0) {
                try {
                    const escapedTerm = termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(escapedTerm, 'gi');
                    const matches = dados.conteudo.match(regex);
                    if (matches) {
                        pontos += matches.length;
                    }
                } catch (error) {
                    console.warn('Erro ao processar termo:', termo, error);
                }
            }
        });
    }

    return pontos;
}

function truncarTexto(texto, tamanhoMaximo) {
    if (texto.length <= tamanhoMaximo) return texto;
    return texto.substring(0, tamanhoMaximo) + '...';
}

// Função auxiliar para identificar categoria da pergunta
async function identificarCategoria(mensagem) {
    const categoriaPrompt = `
    Identifique o tipo desta pergunta em UMA palavra:
    "${mensagem}"
    Responda apenas: GERAL, ESPECIFICO, TECNICO, ADMINISTRATIVO ou CONTABIL`;

    const resp = await client.chat.completions.create({
        messages: [{ role: 'user', content: categoriaPrompt }],
        model: 'llama3-8b-8192',
        temperature: 0.3,
        max_tokens: 50
    });

    return resp.choices[0].message.content.trim();
}

// Função auxiliar para filtrar currículos relevantes
function filtrarCurriculosRelevantes(contextos, mensagem, categoria) {
    return Object.entries(contextos)
        .map(([_, dados]) => ({
            nome: dados.nome,
            conteudo: dados.conteudo,
            relevancia: calcularRelevancia(dados, mensagem, categoria)
        }))
        .sort((a, b) => b.relevancia - a.relevancia)
        .slice(0, 3); // Limita a 3 currículos mais relevantes
}

// Função auxiliar para calcular relevância
function calcularRelevancia(dados, mensagem, categoria) {
    let pontos = 0;
    const termosBusca = mensagem.toLowerCase().split(' ');
    
    // Verifica menção direta ao nome
    if (mensagem.toLowerCase().includes(dados.nome.toLowerCase())) {
        pontos += 10;
    }

    // Verifica categoria
    if (dados.categorias?.areaPrincipal?.toLowerCase().includes(categoria.toLowerCase())) {
        pontos += 5;
    }

    // Conta ocorrências de termos da busca
    termosBusca.forEach(termo => {
        if (dados.conteudo.toLowerCase().includes(termo)) {
            pontos += 1;
        }
    });

    return pontos;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'upload.html'));
});

app.get('/comparar', (req, res) => {
    res.sendFile(path.join(__dirname, 'comparar.html'));
});

app.get('/contexto', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

app.get('/landing', (req, res) => {
    res.sendFile(path.join(__dirname, 'landing.html'));
});

// Rota para a página de login
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/teste-pdf', (req, res) => {
    res.sendFile(path.join(__dirname, 'teste-pdf.html'));
});

// Configuração do cliente Groq
const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

// Configurações do histórico
const MAX_HISTORY = 10;
let conversationHistory = [];

// Inicializa o histórico com o contexto
const contextoInicial = { role: 'system', content: carregarContexto() };
conversationHistory = [contextoInicial];

// Função para gerenciar vagas
function carregarVagas() {
    try {
        const dataPath = path.join(process.cwd(), 'data', 'vagas.json');
        if (!fs.existsSync(dataPath)) {
            fs.writeFileSync(dataPath, JSON.stringify({ jobs: {} }, null, 2));
            return { jobs: {} };
        }
        return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    } catch (error) {
        console.error('Erro ao carregar vagas:', error);
        return { jobs: {} };
    }
}

function salvarVaga(vaga) {
    try {
        const vagas = carregarVagas();
        const id = Date.now().toString();
        vagas.jobs[id] = {
            ...vaga,
            id,
            dataCriacao: new Date().toISOString()
        };
        fs.writeFileSync('./vagas.json', JSON.stringify(vagas, null, 2));
        return id;
    } catch (error) {
        console.error('Erro ao salvar vaga:', error);
        throw error;
    }
}

// Nova rota para listar vagas
app.get('/vagas', (req, res) => {
    try {
        const vagas = carregarVagas();
        res.json({ vagas: Object.values(vagas.jobs) });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar vagas.' });
    }
});

// Nova rota para criar vaga
app.post('/vagas', (req, res) => {
    try {
        const { titulo, descricao, requisitos, nivel, tipo, local } = req.body;
        
        // Convert requisitos to array if it's a string
        const requisitosArray = typeof requisitos === 'string' 
            ? requisitos.split(',').map(req => req.trim())
            : requisitos;

        const id = salvarVaga({
            titulo,
            descricao,
            requisitos: requisitosArray,
            nivel,
            tipo,
            local,
            ativo: true
        });
        res.json({ id, message: 'Vaga criada com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar vaga.' });
    }
});

// Nova rota para excluir vaga
app.delete('/vaga/:id', (req, res) => {
    try {
        const { id } = req.params;
        const vagas = carregarVagas();
        if (!vagas.jobs[id]) {
            return res.status(404).json({ error: 'Vaga não encontrada.' });
        }
        delete vagas.jobs[id];
        fs.writeFileSync('./vagas.json', JSON.stringify(vagas, null, 2));
        res.json({ message: 'Vaga excluída com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir vaga.' });
    }
});

// Adicionar nova rota da página de vagas
app.get('/vagas-page', (req, res) => {
    res.sendFile(__dirname + '/vagas.html');
});

// Adicionar função para categorizar currículos
async function categorizarCurriculo(conteudo) {
    try {
        const prompt = `
        Analise o currículo abaixo e determine a área principal e áreas secundárias.
        Retorne um objeto JSON com o seguinte formato:
        {
            "areaPrincipal": "string (TI, Contabilidade, Administrativo, etc)",
            "areasSecundarias": ["array de strings com outras áreas relevantes"],
            "palavrasChave": ["array de palavras-chave importantes"],
            "nivel": "junior/pleno/senior",
            "categoriasEspecificas": ["array com categorias específicas como 'Desenvolvimento Web', 'Contabilidade Fiscal', etc"]
        }

        Currículo para análise:
        ${conteudo}
        `;

        const categorizacao = await client.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama3-8b-8192',
            temperature: 0.3,
            max_tokens: 1000,
            response_format: { type: "json_object" }
        });

        return JSON.parse(categorizacao.choices[0].message.content);
    } catch (error) {
        console.error('Erro ao categorizar currículo:', error);
        return null;
    }
}

// Adicionar rota para buscar currículos por categoria
app.get('/curriculos/filtrar', (req, res) => {
    try {
        const { area, nivel, palavrasChave } = req.query;
        const contextos = carregarTodosContextos();
        console.log('Filtros recebidos:', { area, nivel, palavrasChave });

        const curriculosFiltrados = Object.entries(contextos)
            .filter(([_, dados]) => {
                // Debug logs
                console.log('Analisando currículo:', dados.nome);
                console.log('Conteúdo do currículo:', dados.conteudo);

                // Verificar área
                const matchArea = !area || (
                    dados.categorias?.areaPrincipal?.toLowerCase().includes(area.toLowerCase()) ||
                    dados.categorias?.areasSecundarias?.some(a => 
                        a.toLowerCase().includes(area.toLowerCase())
                    )
                );

                // Verificar nível
                const matchNivel = !nivel || dados.categorias?.nivel?.toLowerCase() === nivel.toLowerCase();

                // Verificar palavras-chave no conteúdo completo do currículo
                const matchPalavras = !palavrasChave || palavrasChave.split(',').every(palavra => {
                    const termoBusca = palavra.trim().toLowerCase();
                    return (
                        // Procurar nas palavras-chave categorizadas
                        dados.categorias?.palavrasChave?.some(kw => 
                            kw.toLowerCase().includes(termoBusca)
                        ) ||
                        // Procurar no conteúdo completo do currículo
                        dados.conteudo.toLowerCase().includes(termoBusca) ||
                        // Procurar nas habilidades técnicas
                        (dados.categorias?.habilidadesTecnicas || []).some(skill =>
                            skill.toLowerCase().includes(termoBusca)
                        )
                    );
                });

                // Debug dos resultados
                console.log('Resultados do filtro:', {
                    matchArea,
                    matchNivel,
                    matchPalavras
                });

                return matchArea && (!nivel || matchNivel) && matchPalavras;
            })
            .map(([id, dados]) => ({
                id,
                nome: dados.nome,
                resumo: dados.conteudo.substring(0, 200) + '...',
                categorias: dados.categorias || {
                    areaPrincipal: "Não categorizado",
                    areasSecundarias: [],
                    palavrasChave: []
                },
                // Adicionar matches encontrados para destacar
                matches: palavrasChave ? palavrasChave.split(',').map(palavra => {
                    const termo = palavra.trim().toLowerCase();
                    const encontrado = dados.conteudo.toLowerCase().includes(termo);
                    return { termo, encontrado };
                }) : []
            }));

        console.log('Currículos filtrados:', curriculosFiltrados);
        res.json({ curriculos: curriculosFiltrados });
    } catch (error) {
        console.error('Erro ao filtrar currículos:', error);
        res.status(500).json({ error: 'Erro ao filtrar currículos.' });
    }
});

// Nova rota para salvar anotações da entrevista
app.post('/curriculo/notas/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { notas } = req.body;
        
        if (!notas) {
            return res.status(400).json({ error: 'Notas são obrigatórias.' });
        }

        const contextos = carregarTodosContextos();
        
        if (!contextos[id]) {
            return res.status(404).json({ error: 'Currículo não encontrado.' });
        }

        // Initialize or update entrevistaNotas array
        if (!contextos[id].entrevistaNotas) {
            contextos[id].entrevistaNotas = {
                historico: []
            };
        }

        // Add new note to history with timestamp
        contextos[id].entrevistaNotas.historico = [
            ...contextos[id].entrevistaNotas.historico || [],
            {
                texto: notas,
                dataAtualizacao: new Date().toISOString()
            }
        ];

        // Keep the latest note in the main object for backwards compatibility
        contextos[id].entrevistaNotas.texto = notas;
        contextos[id].entrevistaNotas.dataAtualizacao = new Date().toISOString();

        // Save to file
        const dataPath = path.join(dataDir, 'contextos.json');
        fs.writeFileSync(dataPath, JSON.stringify(contextos, null, 2));

        res.json({ 
            message: 'Notas salvas com sucesso.',
            notasHistorico: contextos[id].entrevistaNotas.historico 
        });

    } catch (error) {
        console.error('Erro ao salvar notas:', error);
        res.status(500).json({
            error: 'Erro ao salvar notas.',
            details: error.message
        });
    }
});

function carregarTodosContextos() {
    try {
        const dataPath = path.join(dataDir, 'contextos.json');
        if (!fs.existsSync(dataPath)) {
            // Ensure directory exists
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(dataPath, JSON.stringify({}));
            return {};
        }
        const data = fs.readFileSync(dataPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Erro ao carregar contextos:', error);
        return {};
    }
}


// Iniciar o servidor
const server = app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});


server.timeout = 300000; // 5 minutos

// Update the formatar function for interview notes
function formatarNotasEntrevista(notas) {
    if (!notas) return '';

    let texto = '';
    
    // Add current note
    if (notas.texto) {
        texto += `Nota atual (${new Date(notas.dataAtualizacao).toLocaleString()}): ${notas.texto}\n\n`;
    }
    
    // Add history if exists
    if (notas.historico && notas.historico.length > 0) {
        texto += 'Histórico de entrevistas:\n';
        notas.historico.forEach((nota, index) => {
            texto += `${index + 1}. ${new Date(nota.dataAtualizacao).toLocaleString()}: ${nota.texto}\n`;
        });
    }
    
    return texto;
}

// Modify the chat endpoint to include interview notes history
app.post('/chat', async (req, res) => {
    const { mensagem, sessionId = Date.now().toString() } = req.body;

    if (!mensagem) {
        return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }

    try {
        const history = manageConversationHistory(sessionId);
        const contextosDisponiveis = carregarTodosContextos();

        // Extract context keywords from message and history
        const contextKeywords = extrairPalavrasChave([
            mensagem,
            ...history.messages.map(m => m.content)
        ]);

        // Get mentioned names from current message
        const nomesBuscados = extrairNomesDaPergunta(mensagem);

        // Find relevant curricula based on both history and current context
        const curriculosRelevantes = Object.values(contextosDisponiveis)
            .map(dados => {
                const relevanciaAtual = calcularRelevanciaComNome(dados, mensagem, nomesBuscados);
                const relevanciaHistorica = calcularRelevanciaHistorica(dados, history.messages);
                return {
                    dados,
                    relevancia: relevanciaAtual + relevanciaHistorica
                };
            })
            .sort((a, b) => b.relevancia - a.relevancia)
            .slice(0, 3); // Get top 3 most relevant curricula

        // Create enhanced prompt
        const prompt = `
        CONTEXTO DO SISTEMA:
        Você é um assistente especializado em análise de currículos e recrutamento.
        Use AMBOS os dados do histórico E as informações dos currículos para responder.

        HISTÓRICO DE CONVERSA RECENTE:
        ${history.messages.slice(-3).map(m => 
            `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`
        ).join('\n')}

        DADOS DOS CURRÍCULOS RELEVANTES:
        ${curriculosRelevantes.map(({ dados }) => `
        === CURRÍCULO DE ${dados.nome} ===
        Área: ${dados.categorias?.areaPrincipal || 'Não especificada'}
        Nível: ${dados.categorias?.nivel || 'Não especificado'}
        Experiência: ${extrairExperienciaRelevante(dados.conteudo)}
        Formação: ${extrairFormacao(dados.conteudo)}
        
        HISTÓRICO DE ENTREVISTAS:
        ${dados.entrevistaNotas ? formatarNotasEntrevista(dados.entrevistaNotas) : 'Sem notas de entrevista'}
        
        DETALHES COMPLETOS:
        ${dados.conteudo}
        `).join('\n\n')}

        INSTRUÇÕES DE RESPOSTA:
        1. Priorize informações dos currículos ao responder perguntas específicas sobre candidatos
        2. Use o histórico da conversa para manter contexto e consistência
        3. Seja direto e objetivo nas respostas
        4. Mencione explicitamente a fonte da informação (currículo/histórico/notas de entrevista)
        5. Se não encontrar a informação em nenhuma fonte, diga claramente
        6. Ao mencionar informações das notas de entrevista, indique a data da nota

        PERGUNTA ATUAL: ${mensagem}
    `;

        // Add user message to history
        history.messages.push({ role: 'user', content: mensagem });

        const chatResponse = await client.chat.completions.create({
            messages: [
                { 
                    role: 'system', 
                    content: 'Você é um assistente de RH especializado em análise de currículos.'
                },
                { role: 'user', content: prompt }
            ],
            model: 'llama3-8b-8192',
            temperature: 0.4,
            max_tokens: 1000,
            response_format: { type: "text" }
        });

        const resposta = chatResponse.choices[0].message.content;
        history.messages.push({ role: 'assistant', content: resposta });

        // Trim history if too long
        if (history.messages.length > MAX_HISTORY_LENGTH * 2) {
            history.messages = history.messages.slice(-MAX_HISTORY_LENGTH * 2);
        }

        history.lastUpdated = Date.now();

        res.json({ 
            resposta,
            sessionId,
            historyLength: history.messages.length
        });

    } catch (error) {
        console.error('Erro ao processar mensagem:', error);
        res.status(500).json({
            error: 'Erro ao processar sua mensagem.',
            details: error.message
        });
    }
});

// Update the interview notes endpoint
app.post('/curriculo/notas/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { notas } = req.body;
        
        if (!notas) {
            return res.status(400).json({ error: 'Notas são obrigatórias.' });
        }

        const contextos = carregarTodosContextos();
        
        if (!contextos[id]) {
            return res.status(404).json({ error: 'Currículo não encontrado.' });
        }

        // Initialize or update entrevistaNotas structure
        if (!contextos[id].entrevistaNotas) {
            contextos[id].entrevistaNotas = {
                texto: notas,
                dataAtualizacao: new Date().toISOString(),
                historico: []
            };
        } else {
            // Add current note to history
            if (contextos[id].entrevistaNotas.texto) {
                contextos[id].entrevistaNotas.historico.push({
                    texto: contextos[id].entrevistaNotas.texto,
                    dataAtualizacao: contextos[id].entrevistaNotas.dataAtualizacao
                });
            }
            // Update current note
            contextos[id].entrevistaNotas.texto = notas;
            contextos[id].entrevistaNotas.dataAtualizacao = new Date().toISOString();
        }

        // Save to file
        const dataPath = path.join(dataDir, 'contextos.json');
        fs.writeFileSync(dataPath, JSON.stringify(contextos, null, 2));

        res.json({ 
            message: 'Notas salvas com sucesso.',
            entrevistaNotas: contextos[id].entrevistaNotas
        });

    } catch (error) {
        console.error('Erro ao salvar notas:', error);
        res.status(500).json({
            error: 'Erro ao salvar notas.',
            details: error.message
        });
    }
});