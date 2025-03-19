require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const fs = require('fs');
const app = express();

const port = process.env.PORT || 3000;
const multer = require('multer');
const pdfParse = require('pdf-parse');
const path = require('path');


// Aumentar o timeout para 5 minutos
app.use(express.json({ limit: '10mb', extended: true }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname))); 



// Função para dividir texto em chunks menores
function dividirTextoEmChunks(texto, tamanhoMaximo = 2000) { // Reduzido para 2000 tokens
    const paragrafos = texto.split(/\n\s*\n/);
    const chunks = [];
    let chunkAtual = '';
    
    for (const paragrafo of paragrafos) {
        if ((chunkAtual + paragrafo).length > tamanhoMaximo && chunkAtual.length > 0) {
            chunks.push(chunkAtual);
            chunkAtual = paragrafo;
        } else {
            chunkAtual += (chunkAtual ? '\n\n' : '') + paragrafo;
        }
    }
    
    if (chunkAtual.length > 0) {
        chunks.push(chunkAtual);
    }
    
    return chunks;
}

// Função para processar chunks com rate limiting
async function processarChunksComRateLimit(chunks, processarFuncao) {
    const resultados = [];
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const maxTokensPorChunk = 2000; // Reduzido para garantir que não exceda o limite

    for (let i = 0; i < chunks.length; i++) {
        try {
            console.log(`Processando chunk ${i + 1}/${chunks.length}...`);
            
            if (chunks[i].length > maxTokensPorChunk) {
                console.log(`Chunk ${i + 1} excede o limite de tokens, dividindo...`);
                const subChunks = dividirTextoEmChunks(chunks[i], maxTokensPorChunk);
                const subResultados = await processarChunksComRateLimit(subChunks, processarFuncao);
                resultados.push(...subResultados);
                continue;
            }

            const resultado = await processarFuncao(chunks[i]);
            resultados.push(resultado);

            if (i < chunks.length - 1) {
                console.log('Aguardando 1 segundo antes do próximo chunk...');
                await delay(1000);
            }
        } catch (error) {
            console.error(`Erro ao processar chunk ${i + 1}:`, error);
            console.log('Erro detectado, aguardando 5 segundos...');
            await delay(5000);

            resultados.push("Não foi possível processar esta parte do documento.");
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
                model: 'llama3-70b-8192',
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
        model: 'llama3-70b-8192',
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

// Função para gerenciar múltiplos contextos
async function salvarContexto(nomeArquivo, conteudo) {
    try {
        const contextos = carregarTodosContextos();
        
        // Extrair nome do candidato do conteúdo processado
        const nomeCandidato = extrairNomeDoCandidato(conteudo);
        const conteudoLimpo = conteudo.replace(/NOME_CANDIDATO:[^\n]+\n/, '').trim();
        
        // Adicionar categorização
        const categorias = await categorizarCurriculo(conteudoLimpo);

        contextos[nomeArquivo] = {
            nome: nomeCandidato || nomeArquivo.replace(/_/g, ' ').replace(/\.pdf$/i, ''),
            conteudo: conteudoLimpo,
            nomeArquivo: nomeArquivo,
            categorias: categorias,
            dataCriacao: new Date().toISOString(),
            ultimaAtualizacao: new Date().toISOString()
        };

        fs.writeFileSync('./contextos.json', JSON.stringify(contextos, null, 2));
        return true;
    } catch (error) {
        console.error('Erro ao salvar contexto:', error);
        return false;
    }
}

function carregarTodosContextos() {
    try {
        if (!fs.existsSync('./contextos.json')) {
            fs.writeFileSync('./contextos.json', '{}');
            return {};
        }
        return JSON.parse(fs.readFileSync('./contextos.json', 'utf8'));
    } catch (error) {
        console.error('Erro ao carregar contextos:', error);
        return {};
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
                // Process the uploaded file
                const textoExtraido = await extrairTextoDePDF(file.path);
                const contextoMelhorado = await processarPDFGrande(textoExtraido);
                
                // Save the processed content
                await salvarContexto(nomeArquivo, contextoMelhorado);
                
                resultados.push({
                    id: nomeArquivo,
                    nome: nomeArquivo,
                    resumo: contextoMelhorado.substring(0, 200) + '...',
                    arquivo: file.filename // Save the filename for future reference
                });

            } catch (processError) {
                console.error(`Erro ao processar ${file.originalname}:`, processError);
                // Don't delete the file if processing fails - keep it for debugging
                resultados.push({
                    id: nomeArquivo,
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

            return {
                id: id,
                nome: nome,
                resumo: typeof conteudo === 'string' ? conteudo.substring(0, 200) + '...' : 'Sem resumo',
                categorias: categorias || {
                    areaPrincipal: 'Não categorizado',
                    areasSecundarias: [],
                    palavrasChave: []
                }
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
            model: 'llama3-70b-8192',
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

// Nova rota para listar currículos disponíveis
app.get('/curriculos', (req, res) => {
    try {
        const contextos = carregarTodosContextos();
        const curriculos = Object.keys(contextos).map(id => {
            const dados = contextos[id];
            return {
                id: id,
                nome: dados.nome || id, // Usa o nome armazenado ou o ID como fallback
                resumo: dados.conteudo.substring(0, 200) + '...',
                dataCriacao: dados.dataCriacao
            };
        });
        
        console.log('Currículos disponíveis:', curriculos); // Debug
        res.json({ curriculos });
    } catch (error) {
        console.error('Erro ao listar currículos:', error);
        res.status(500).json({
            error: 'Erro ao listar currículos.',
            details: error.message
        });
    }
});

// Adicionar nova rota para deletar currículo
app.delete('/curriculo/:id', (req, res) => {
    try {
        const id = req.params.id;
        const contextos = carregarTodosContextos();
        
        if (!contextos[id]) {
            return res.status(404).json({ error: 'Currículo não encontrado.' });
        }
        
        delete contextos[id];
        fs.writeFileSync('./contextos.json', JSON.stringify(contextos, null, 2));
        
        res.json({ message: 'Currículo deletado com sucesso.' });
    } catch (error) {
        console.error('Erro ao deletar currículo:', error);
        res.status(500).json({
            error: 'Erro ao deletar currículo.',
            details: error.message
        });
    }
});

// Atualiza a rota do chat para usar o novo contexto
app.post('/chat', async (req, res) => {
    const { mensagem } = req.body;

    if (!mensagem) {
        return res.status(400).json({ error: 'A mensagem é obrigatória.' });
    }

    try {
        // Carrega todos os contextos disponíveis
        const contextoAtual = carregarTodosContextosParaChat();
        
        // Adiciona mensagem do usuário ao histórico
        gerenciarHistorico({ role: 'user', content: mensagem });

        const prompt = `
        Você é um assistente especializado em análise de currículos.
        Use as informações abaixo para responder às perguntas sobre os candidatos.
        Quando perguntar sobre nomes, use exatamente os nomes conforme aparecem após "CURRÍCULO DE:".

        CONTEXTO DOS CURRÍCULOS:
        ${contextoAtual}

        PERGUNTA DO USUÁRIO:
        ${mensagem}
        `;

        const chatCompletion = await client.chat.completions.create({
            messages: [
                { 
                    role: 'system', 
                    content: 'Você é um assistente especializado em análise de currículos. Use o contexto fornecido para respostas precisas.'
                },
                { role: 'user', content: prompt }
            ],
            model: 'llama3-70b-8192',
            temperature: 0.7,
            max_tokens: 2048,
            stream: false
        });

        const resposta = chatCompletion.choices[0].message.content;
        
        // Adiciona resposta ao histórico
        gerenciarHistorico({ role: 'assistant', content: resposta });

        res.json({ resposta });

    } catch (error) {
        console.error('Erro ao obter resposta da Groq:', error);
        res.status(500).json({
            error: 'Erro ao processar sua mensagem.',
            details: error.message
        });
    }
});

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
        if (!fs.existsSync('./vagas.json')) {
            fs.writeFileSync('./vagas.json', JSON.stringify({ jobs: {} }, null, 2));
            return { jobs: {} };
        }
        return JSON.parse(fs.readFileSync('./vagas.json', 'utf8'));
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
            model: 'llama3-70b-8192',
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

// Iniciar o servidor
const server = app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});

server.timeout = 300000; // 5 minutos
