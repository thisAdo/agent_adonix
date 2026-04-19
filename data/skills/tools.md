# Herramientas disponibles

## Lectura y navegacion

list_dir { path? }
  Lista archivos y carpetas del directorio, ordenados. Sin path usa cwd.
  Usa esto PRIMERO para entender la estructura de un proyecto.
  Ejemplo: {"type":"tool","tool":"list_dir","args":{"path":"src"}}

read_file { path, startLine?, endLine? }
  Lee archivo con numeros de linea. Maximo 250 lineas por llamada.
  Para archivos grandes, lee por secciones con startLine/endLine.
  SIEMPRE lee antes de editar.
  Ejemplo lectura parcial: {"type":"tool","tool":"read_file","args":{"path":"src/app.js","startLine":1,"endLine":50}}

search_text { pattern, path?, glob? }
  Busqueda regex en archivos (motor ripgrep). Rapido incluso en proyectos grandes.
  - pattern: expresion regular (ej: "function\s+\w+", "TODO|FIXME|HACK")
  - path: directorio base de busqueda (default: cwd)
  - glob: filtro de archivos (ej: "*.js", "*.{ts,tsx}", "src/**/*.py")
  Ejemplo: {"type":"tool","tool":"search_text","args":{"pattern":"import.*express","path":".","glob":"*.js"}}
  NOTA: pattern es regex. Escapa caracteres especiales: \., \(, \[, etc.

glob_files { pattern, path? }
  Encuentra archivos por patron glob. No busca contenido, solo nombres.
  Patrones: * (cualquier nombre), ** (cualquier profundidad), ? (un caracter)
  Ejemplos utiles:
  - Todos los JS: {"type":"tool","tool":"glob_files","args":{"pattern":"**/*.js"}}
  - Tests: {"type":"tool","tool":"glob_files","args":{"pattern":"**/*.test.*"}}
  - Configs: {"type":"tool","tool":"glob_files","args":{"pattern":"*config*"}}
  NOTA: pattern NO es regex. Es glob (*, **, ?). No uses \s, \d, etc.

file_info { path }
  Metadata de archivo: tamano, tipo (file/directory), permisos, fechas.
  Util para verificar que un archivo existe antes de operar.

## Escritura y edicion

write_file { path, content }
  Crea archivo nuevo o sobrescribe existente. Crea directorios padre automaticamente.
  PELIGROSO: sobrescribe sin preguntar. Verifica que el path es correcto.
  Usa para: crear archivos nuevos, reescribir archivos pequenos completamente.
  CRITICO — preserva TODOS los caracteres del codigo fuente:
  - Template literals con backtick: `texto ${variable}` (el backtick es literal en JSON)
  - Operadores aritmeticos: *, +, -, /, %, **
  - Operadores logicos: &&, ||, !, ??
  - Regex: /patron/flags
  - Caracteres especiales: ~, ^, |, &
  - NUNCA omitas, simplifiques ni resumas caracteres del codigo
  Ejemplo: {"type":"tool","tool":"write_file","args":{"path":"src/utils.js","content":"const add = (a, b) => a + b;\nmodule.exports = { add };"}}

append_file { path, content }
  Agrega contenido al FINAL de un archivo existente. No modifica lo existente.
  Usa para: agregar entradas a logs, nuevas funciones al final de un modulo.

replace_in_file { path, search, replace, all? }
  Reemplaza texto literal en archivo. NO es regex, es match exacto.
  CRITICO: search debe coincidir CARACTER POR CARACTER con el archivo, incluyendo
  espacios, tabs, saltos de linea, e indentacion. Copia del read_file tal cual.
  - all: true reemplaza TODAS las coincidencias, false solo la primera (default).
  Si falla: relee el archivo, probablemente el texto cambio o tiene whitespace diferente.
  Ejemplo: {"type":"tool","tool":"replace_in_file","args":{"path":"src/app.js","search":"const PORT = 3000;","replace":"const PORT = process.env.PORT || 3000;"}}

make_dir { path }
  Crea directorio y todos los directorios padre necesarios.

## Ejecucion

run_command { command }
  Ejecuta comando en bash. Timeout: 2 minutos. Retorna { exitCode, stdout, stderr }.
  Directorio de trabajo: el cwd actual del agente.
  REGLAS:
  - Siempre usa flags no-interactivos: -y, --yes, --no-pager, --quiet
  - DEBIAN_FRONTEND=noninteractive para apt
  - Encadena con && para operaciones secuenciales
  - Limita output largo: | head -50, | tail -20, | grep "patron"
  - Para procesos largos, considera timeout o background (&)
  Ejemplo: {"type":"tool","tool":"run_command","args":{"command":"npm install express && npm test"}}

## Web y scraping

fetch_url { url, selector?, attribute?, limit? }
  Descarga pagina web y extrae contenido.
  Modos de uso:
  - Sin selector: retorna HTML completo (util para inspeccionar estructura).
  - Con selector CSS: extrae texto de los elementos que coinciden.
  - Con selector + attribute: extrae un atributo (href, src, class, etc).
  - limit: maximo de elementos a extraer (default: 20, max: 50).
  Selectores CSS comunes: "h1", ".clase", "#id", "a", "div.card > h2", "meta[name=description]"
  Estrategia de scraping:
  1. Primero fetch sin selector para ver el HTML y entender la estructura.
  2. Luego fetch con selector especifico para extraer lo que necesitas.
  Ejemplo: {"type":"tool","tool":"fetch_url","args":{"url":"https://example.com","selector":"h1"}}

## Seleccion de herramienta

Pregunta: "donde se usa X?" → search_text con patron
Pregunta: "que archivos hay?" → list_dir o glob_files
Pregunta: "que dice este archivo?" → read_file
Pregunta: "ejecuta esto" → run_command
Pregunta: "crea/edita archivo" → read_file primero, luego write_file o replace_in_file
Pregunta: "descarga/scrapea" → fetch_url
