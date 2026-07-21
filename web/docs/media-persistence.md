# Mídia indisponível

Arquivos WAHA antigos que retornam 404 são marcados localmente como
`unavailable` quando a persistência os encontra. A UI mostra um fallback e não
repete a requisição. A API converte a ausência em 404 controlado e não deixa
erros de stream ou Promises em segundo plano encerrarem o processo.

O player de áudio tem controles de play/pausa, seek, duração e 1x/1.5x/2x;
iniciar outro áudio pausa o anterior.
