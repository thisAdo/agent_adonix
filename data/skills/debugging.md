# Depuración Sistemática

## Resumen

Las correcciones aleatorias hacen perder tiempo y crean nuevos errores. Los parches rápidos enmascaran problemas subyacentes.

**Principio fundamental:** SIEMPRE encontrar la causa raíz antes de intentar las correcciones. Las correcciones de síntomas son un fracaso.

**Violar la letra de este proceso es violar el espíritu de la depuración.**

## La Ley de Hierro

```
NO HAY CORRECCIONES SIN INVESTIGACIÓN DE LA CAUSA RAÍZ PRIMERO
```

Si no has completado la Fase 1, no puedes proponer correcciones.

## Cuándo Usar

Usar para CUALQUIER problema técnico:
- Fallos de prueba
- Errores en producción
- Comportamiento inesperado
- Problemas de rendimiento
- Fallos de compilación
- Problemas de integración

**Usar ESTO ESPECIALMENTE cuando:**
- Bajo presión de tiempo (las emergencias hacen que adivinar sea tentador)
- Parece obvia una "rápida corrección"
- Ya has intentado múltiples correcciones
- La corrección anterior no funcionó
- No entiendes completamente el problema

**No omitir cuando:**
- El problema parece simple (los errores simples también tienen causas raíz)
- Tienes prisa (la prisa garantiza retrabajo)
- El gerente quiere que se arregle AHORA (lo sistemático es más rápido que el caos)

## Las Cuatro Fases

DEBES completar cada fase antes de pasar a la siguiente.

### Fase 1: Investigación de la Causa Raíz

**ANTES de intentar CUALQUIER corrección:**

1. **Leer los Mensajes de Error Detenidamente**
   - No te saltes errores o advertencias
   - A menudo contienen la solución exacta
   - Lee las trazas de pila completas
   - Anota números de línea, rutas de archivo, códigos de error

2. **Reproducir Consistentemente**
   - ¿Puedes desencadenarlo de manera confiable?
   - ¿Cuáles son los pasos exactos?
   - ¿Sucede siempre?
   - Si no es reproducible → recopila más datos, no adivines

3. **Verificar Cambios Recientes**
   - ¿Qué cambió que podría causar esto?
   - `git diff`, commits recientes
   - Nuevas dependencias, cambios de configuración
   - Diferencias ambientales

4. **Recopilar Evidencia en Sistemas Multi-Componente**

   **CUANDO el sistema tiene múltiples componentes (CI → build → signing, API → service → database):**

   **ANTES de proponer correcciones, agrega instrumentación de diagnóstico:**
   ```
   Para CADA límite de componente:
     - Registra qué datos entran al componente
     - Registra qué datos salen del componente
     - Verifica la propagación del entorno/configuración
     - Comprueba el estado en cada capa

   Ejecuta una vez para recopilar evidencia que muestre DÓNDE falla
   LUEGO analiza la evidencia para identificar el componente que falla
   LUEGO investiga ese componente específico
   ```

   **Ejemplo (sistema multi-capa):**
   ```bash
   # Capa 1: Workflow
   echo "=== Secretos disponibles en el workflow: ==="
   echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

   # Capa 2: Script de build
   echo "=== Variables de entorno en el script de build: ==="
   env | grep IDENTITY || echo "IDENTITY no está en el entorno"

   # Capa 3: Script de firma
   echo "=== Estado del llavero: ==="
   security list-keychains
   security find-identity -v

   # Capa 4: Firma real
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   ```

   **Esto revela:** Qué capa falla (secretos → workflow ✓, workflow → build ✗)

5. **Rastrear el Flujo de Datos**

   **CUANDO el error está profundo en la pila de llamadas:**

   Consulta `root-cause-tracing.md` en este directorio para la técnica completa de rastreo hacia atrás.

   **Versión rápida:**
   - ¿De dónde se origina el valor incorrecto?
   - ¿Qué llamó a esto con el valor incorrecto?
   - Sigue rastreando hacia arriba hasta encontrar la fuente
   - Corrige en la fuente, no en el síntoma

### Fase 2: Análisis de Patrones

**Encuentra el patrón antes de corregir:**

1. **Encontrar Ejemplos de Trabajo**
   - Localiza código similar que funcione en la misma base de código
   - ¿Qué funciona que sea similar a lo que está roto?

2. **Comparar con Referencias**
   - Si implementas un patrón, lee la implementación de referencia COMPLETAMENTE
   - No escanees, lee cada línea
   - Comprende el patrón completamente antes de aplicarlo

3. **Identificar Diferencias**
   - ¿Qué es diferente entre lo que funciona y lo que está roto?
   - Enumera cada diferencia, por pequeña que sea
   - No asumas "eso no puede importar"

4. **Comprender las Dependencias**
   - ¿Qué otros componentes necesita?
   - ¿Qué configuraciones, entorno?
   - ¿Qué suposiciones hace?

### Fase 3: Hipótesis y Pruebas

**Método científico:**

1. **Formular una Hipótesis Única**
   - Declara claramente: "Creo que X es la causa raíz porque Y"
   - Escríbelo
   - Sé específico, no vago

2. **Probar Mínimamente**
   - Haz el cambio MÁS PEQUEÑO posible para probar la hipótesis
   - Una variable a la vez
   - No corrijas múltiples cosas a la vez

3. **Verificar Antes de Continuar**
   - ¿Funcionó? Sí → Fase 4
   - ¿No funcionó? Formula NUEVA hipótesis
   - NO agregues más correcciones encima

4. **Cuando No Sabes**
   - Di "No entiendo X"
   - No finjas saber
   - Pide ayuda
   - Investiga más

### Fase 4: Implementación

**Corrige la causa raíz, no el síntoma:**

1. **Crear un Caso de Prueba Fallido**
   - La reproducción más simple posible
   - Prueba automatizada si es posible
   - Script de prueba único si no hay framework
   - DEBE existir antes de corregir
   - Usa la habilidad `superpowers:test-driven-development` para escribir pruebas fallidas adecuadas

2. **Implementar una Corrección Única**
   - Aborda la causa raíz identificada
   - UN cambio a la vez
   - Sin mejoras de "mientras estoy aquí"
   - Sin refactorización agrupada

3. **Verificar la Corrección**
   - ¿La prueba pasa ahora?
   - ¿No se rompieron otras pruebas?
   - ¿El problema se resolvió realmente?

4. **Si la Corrección No Funciona**
   - DETENTE
   - Cuenta: ¿Cuántas correcciones has intentado?
   - Si < 3: Regresa a la Fase 1, reanaliza con nueva información
   - **Si ≥ 3: DETENTE y cuestiona la arquitectura (paso 5 a continuación)**
   - NO intentes la Corrección #4 sin una discusión arquitectónica

5. **Si Fallaron 3+ Correcciones: Cuestionar la Arquitectura**

   **Patrón que indica un problema arquitectónico:**
   - Cada corrección revela un nuevo estado compartido/acoplamiento/problema en un lugar diferente
   - Las correcciones requieren "refactorización masiva" para implementarse
   - Cada corrección crea nuevos síntomas en otros lugares

   **DETENTE y cuestiona los fundamentos:**
   - ¿Es este patrón fundamentalmente sólido?
   - ¿Estamos "manteniéndolo por pura inercia"?
   - ¿Deberíamos refactorizar la arquitectura en lugar de seguir corrigiendo síntomas?

   **Discute con tu compañero humano antes de intentar más correcciones**

   Esto NO es una hipótesis fallida, es una arquitectura incorrecta.

## Señales de Alerta - DETENTE y Sigue el Proceso

Si te encuentras pensando:
- "Corrección rápida por ahora, investigaré después"
- "Solo intenta cambiar X y mira si funciona"
- "Agrega múltiples cambios, ejecuta las pruebas"
- "Omite la prueba, la verificaré manualmente"
- "Probablemente sea X, déjame arreglar eso"
- "No entiendo completamente pero esto podría funcionar"
- "El patrón dice X pero lo adaptaré de manera diferente"
- "Estos son los problemas principales: [enumera correcciones sin investigación]"
- Proponer soluciones antes de rastrear el flujo de datos
- **"Un intento de corrección más" (cuando ya se intentaron 2+)**
- **Cada corrección revela un nuevo problema en un lugar diferente**

**TODOS estos significan: DETENTE. Regresa a la Fase 1.**

**Si fallaron 3+ correcciones: Cuestiona la arquitectura (ver Fase 4.5)**

## Las Señales de Tu Compañero Humano Indican Que Lo Estás Haciendo Mal

**Observa estas redirecciones:**
- "¿Eso no está sucediendo?" - Asumiste sin verificar
- "¿Nos mostrará...?" - Deberías haber agregado recopilación de evidencia
- "Deja de adivinar" - Estás proponiendo correcciones sin entender
- "Piensa esto a fondo" - Cuestiona los fundamentos, no solo los síntomas
- "¿Estamos atascados?" (frustrado) - Tu enfoque no está funcionando

**Cuando veas esto: DETENTE. Regresa a la Fase 1.**

## Justificaciones Comunes

| Excusa | Realidad |
|--------|---------|
| "El problema es simple, no necesito el proceso" | Los problemas simples también tienen causas raíz. El proceso es rápido para errores simples. |
| "Emergencia, no hay tiempo para el proceso" | La depuración sistemática es MÁS RÁPIDA que el caos de adivinar y probar. |
| "Solo intenta esto primero, luego investiga" | La primera corrección establece el patrón. Hazlo bien desde el principio. |
| "Escribiré la prueba después de confirmar que la corrección funciona" | Las correcciones sin probar no se mantienen. La prueba primero lo demuestra. |
| "Múltiples correcciones a la vez ahorran tiempo" | No se puede aislar lo que funcionó. Crea nuevos errores. |
| "La referencia es muy larga, adaptaré el patrón" | La comprensión parcial garantiza errores. Léela completamente. |
| "Veo el problema, déjame arreglarlo" | Ver síntomas ≠ entender la causa raíz. |
| "Un intento de corrección más" (después de 2+ fallos) | 3+ fallos = problema arquitectónico. Cuestiona el patrón, no corrijas de nuevo. |

## Referencia Rápida

| Fase | Actividades Clave | Criterios de Éxito |
|-------|---------------|------------------|
| **1. Causa Raíz** | Leer errores, reproducir, verificar cambios, recopilar evidencia | Entender QUÉ y POR QUÉ |
| **2. Patrón** | Encontrar ejemplos de trabajo, comparar | Identificar diferencias |
| **3. Hipótesis** | Formular teoría, probar mínimamente | Hipótesis confirmada o nueva |
| **4. Implementación** | Crear prueba, corregir, verificar | Problema resuelto, pruebas pasan |

## Cuando el Proceso Revela "Sin Causa Raíz"

Si la investigación sistemática revela que el problema es realmente ambiental, dependiente del tiempo o externo:

1. Has completado el proceso
2. Documenta lo que investigaste
3. Implementa el manejo apropiado (reintento, tiempo de espera, mensaje de error)
4. Agrega monitoreo/registro para futuras investigaciones

**Pero:** el 95% de los casos de "sin causa raíz" son una investigación incompleta.

## Impacto en el Mundo Real

De sesiones de depuración:
- Enfoque sistemático: 15-30 minutos para corregir
- Enfoque de correcciones aleatorias: 2-3 horas de caos
- Tasa de corrección en el primer intento: 95% vs 40%
- Nuevos errores introducidos: Casi cero vs común
