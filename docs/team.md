# Modelo de empleado y registro por invitación

## Team Check-in · 31/10/2026

La colección visible del CMS local se llama **Team Check-in** (`api::team-checkin.team-checkin`, tabla `team_checkins`). Se retiraron la API y el modelo `api::checkin.checkin`, la vinculación de llegadas por nombre y la purga manual obsoleta. La eliminación de usuarios opera solo sobre las asistencias vinculadas; conserva los campos vacíos del contrato anterior para compatibilidad.

En la base PostgreSQL compartida configurada en el CMS local se eliminaron los dos registros antiguos y se añadieron nueve registros solicitados: Alexa y Brenda, del 27 al 30 de octubre a las 08:00 de Ciudad de México; Brenda, enfermedad el 31 a las 08:00. Se preservó el registro existente de Alexa del sábado. No se publicó el código en Railway; su tabla antigua queda vacía para no romper las consultas del CMS alojado mientras use el código anterior.


## Asistencia registrada por administración

`PUT /api/team-admin/employees/:documentId/checkins/:date` (política `team-admin`) recibe solo `{ status }` con `on_time`, `late` o `sick` y crea o reemplaza el registro único de ese empleado y día. Las horas son fijas en Ciudad de México: 08:00 para puntual y enfermedad, 09:00 para con retraso; la puntualidad sigue derivándose de la hora. Rechaza días futuros, el día de descanso configurado en `paymentAccount.restDay` y cuentas operativas; la pestaña tampoco ofrece opciones ese día. Next expone la misma ruta en `/api/team/admin/employees/:documentId/checkins/:date` y la pestaña Mi pago de Personas muestra los días de la semana de pago con las tres opciones.

## Base sueldos

Un único documento de `api::team-salary-week.team-salary-week`, con clave privada y única `recordKey=base-sueldos`, conserva la fecha de referencia y siete filas fijas (`dayIndex` 0–6, lunes–domingo). No hay registros por semana ni historial. `referenceDate` guarda la fecha exacta elegida; de ella se derivan las fechas de las filas. Actualizarla sobrescribe el mismo campo y conserva los cinco datos capturados de cada día.

El primer acceso administrativo inicializa y guarda la fecha actual de Ciudad de México si falta. Si no hay base, crea un único documento con captura pendiente. Si ya hay datos, añade la fecha sin reemplazarlos. El bloqueo transaccional común evita dos inicializaciones concurrentes. Las fechas guardadas no se cambian automáticamente en lecturas posteriores.

`GET/PUT /api/team-admin/base-salaries` no filtran por fecha y exigen Users & Permissions y `team-admin`. PUT recibe `{ referenceDate, revision, days }`; la revisión detecta ediciones concurrentes sin conservar valores anteriores. No hay rutas REST genéricas ni publicación por versiones. Next recalcula los resultados y rechaza fechas por fila o resultados enviados como entradas.

La columna antigua `weekStart` sigue opcional y privada, sin uso. Las entradas JSON anteriores con fecha se convierten a posiciones lunes–domingo sin perder importes. Los nombres internos y tablas se conservan para evitar renombrar almacenamiento existente. El módulo y sus pruebas se sincronizan con `../generoso-cms`.

Las comprobaciones usan dobles de persistencia; no confirman migración o conexión real a PostgreSQL. No se desplegó.

## Mi pago · datos del paso 2

`team-checkin.kind` distingue `normal` y `sick`, es privado y tiene valor inicial `normal`. La utilidad `attendanceKind` interpreta también los registros antiguos sin tipo como normales, sin reescribirlos. La clave única por empleado/día y las restricciones del check-in normal permanecen vigentes. El endpoint de enfermedad y su interfaz están implementados en el paso 3, descrito más abajo.

`team-employee.paymentAccount` es un JSON privado que contiene únicamente la configuración y ajustes vigentes del empleado: sueldo mensual, descanso, grupo fijo/auxiliar, consumos, extra, efectivo y revisión. No hay colección de pagos ni registros por semana. Sueldo, descanso y grupo empiezan pendientes; no se inventan valores. Los campos calculados y las fechas no se guardan en esa cuenta. Los DTO de perfil/sesión conservan su lista explícita de campos y no exponen este JSON.

El servicio interno `team-payment` permite lectura de la cuenta propia por identidad vinculada y lectura/actualización parcial administrativas. Comprueba acceso administrativo, vuelve a comprobarlo dentro de la transacción y coordina los bloqueos con asistencia/eliminación. Una revisión evita sobrescrituras concurrentes; el nuevo valor sustituye al anterior sin historial. Las rutas administrativas del paso 5 conectan lectura/actualización de configuración; siguen excluidas de las respuestas generales de perfil. Los identificadores de cuenta/actor deberán proceder de la sesión autenticada cuando se conecten.

El módulo y la prueba `tests/team-payment.test.js` se sincronizan con el CMS activo. Las verificaciones usan dobles de persistencia y el validador instalado de Strapi; no ejecutan migraciones ni prueban PostgreSQL real. No se desplegó.

## Mi pago · conexión del paso 4

`team-payment-summary` calcula desde `paymentAccount`, la única Base sueldos y los registros del empleado dentro de la semana derivada de la fecha guardada en Base sueldos. Toma el bloqueo común de asistencia/cuentas y el de la base, en ese orden, durante la lectura. No almacena resúmenes ni inicializa una base o cuenta ausente.

`GET /api/team/payment` usa la identidad de la sesión y política `team-member`; `GET /api/team-admin/employees/:documentId/payment` exige política `team-admin` y autorización interna para consultar otro perfil. Ambas rechazan parámetros de consulta. Devuelven solo el desglose del empleado, revisiones, fecha guardada y configuración pendiente; no exponen las entradas de Base sueldos ni asistencia ajena. Next publica las mismas rutas y proyecta los campos permitidos.

Los módulos `utils/payment-calculation/*.js` se generan desde las reglas TypeScript del frontend con `node scripts/generate-team-payment.mjs`, ejecutado en `generoso-management`, que los escribe directamente en este repositorio. Regenerarlos al cambiar fórmulas; una prueba del frontend detecta diferencias. No se añade una dependencia de TypeScript al CMS en ejecución.

Sin configuración se devuelve `unconfigured`; sin base/fecha, `base_pending`. Con entradas de reparto incompletas se preservan importes `null` y estado `pending`. El paso 5 añade los ajustes y el cálculo de total/depósito por separado. La pantalla Mi pago queda para el paso 6.

Validación: 12 pruebas dirigidas del CMS y 8 de API/proyección/módulos generados pasan, además de lint y tipos limitados. Archivos sincronizados con el CMS activo, sin desplegar ni probar datos reales.

## Mi pago · edición y ajustes del paso 5

`GET/PATCH /api/team-admin/employees/:documentId/payment/settings` usa política administrativa y el servicio `team-payment`. PATCH admite `{ revision, changes }` solo con sueldo mensual, descanso, grupo de reparto, consumos, extra y efectivo; revalida al administrador bajo bloqueo y devuelve conflicto 409 si la revisión cambió. No acepta fechas, períodos, días pagados, puntualidad ni totales. Next exige además origen propio y sesión administrativa.

`team-payment-summary` aplica el módulo generado `employee-payment-adjustments`: total = subtotal + extra − consumos; depósito = total − efectivo. Los ajustes son propios del empleado, mantienen `null` si falta subtotal y conservan saldos negativos para revisión. No se crean registros históricos ni movimientos de efectivo; el campo significa efectivo entregado de esta cuenta vigente.

Equipo incluye «Cuenta de pago» por persona con carga al abrir, edición manual y desglose automático. Conflictos o guardados inciertos conservan el borrador y requieren recarga antes de otra escritura. Los demás datos del perfil, permisos, asistencia y Base sueldos se conservan.

Validación del paso 5: 49 pruebas dirigidas pasan, con lint y tipos limitados a lo afectado. Código sincronizado con el CMS activo. Sin despliegue ni pruebas con datos reales. La pantalla personal Mi pago está implementada en el paso 6 y utiliza las rutas de lectura existentes. No añade cambios al CMS.

## Mi pago · validación conjunta del paso 7

Pasan 159 pruebas específicas de la función: 59 del CMS, 97 de cálculo/APIs/componentes del frontend y 3 de flujo conjunto. `team/tests/payment-flow.test.mjs`, ejecutado desde `generoso-management` con `NODE_PATH='../generoso-cms/node_modules' node --test team/tests/payment-flow.test.mjs`, conecta rutas Next con políticas, controladores, servicios y cálculos reales del CMS usando persistencia/transporte/sesión simulados.

Se comprueban base única, asistencia normal/enfermedad, corte de puntualidad, descanso, reparto, cuenta vigente, consumos reemplazados, total/depósito, consulta propia, autorización, conflicto y rollback. Cambiar la referencia conserva importes y asistencia previa sin crear pagos históricos. Los 26 archivos pertinentes del CMS activo coinciden con la referencia. No se modificó código funcional en este paso.

Lint de la nueva prueba, tipos focalizados y revisión de espacios correctos. Sin suite completa, builds, navegador, despliegue o datos reales. Las pruebas con adaptadores no equivalen a verificar PostgreSQL o JWT reales.

## Modelo de empleado

Pasos 2–9 instalados en `../generoso-cms` (Strapi 5.59.0), con sincronización de PostgreSQL externo autorizada expresamente por Fredy. Este repositorio es la única fuente del backend; `generoso-management` ya no guarda una copia (02/11/2026).

El CMS local se recargó y creó `team_employees` y `team_employees_account_lnk` en la conexión externa de desarrollo (`DATABASE_PUBLIC_URL`). No se eliminaron tablas y los conteos de cuentas y check-ins existentes se mantuvieron iguales. La generación automática de tipos del CMS incorporó `ApiTeamEmployeeTeamEmployee` a `types/generated/contentTypes.d.ts`. No se publicó un despliegue de Railway: el proceso local ya reconoce el modelo; el código del proceso alojado se actualizará cuando se despliegue el repositorio del CMS.

## Foto de perfil

Mi perfil permite agregar o reemplazar una foto propia mediante `GET/PUT /api/team/profile/photo` de Next y `GET/PUT /api/team/profile/photo` del CMS. El servidor deriva siempre la identidad de la sesión; no admite identificadores de empleados en URL ni cuerpo. Se requiere perfil activo y cuenta confirmada, local y no bloqueada.

El navegador acepta JPG, PNG y WebP de hasta 5 MB y prepara un JPEG de hasta 512 px. El CMS verifica y vuelve a codificar la imagen con Sharp, ya instalado por Strapi Upload, eliminando metadatos originales. El resultado se guarda directamente en PostgreSQL como JPEG base64 en el campo de texto privado `team-employee.profilePhoto`; reemplazarlo sobrescribe la foto actual. No se crean archivos públicos ni historial. La foto se consulta por separado, con `no-store`, y no se incluye en las respuestas ordinarias de perfil, sesión, invitación o listado de empleados.

El guardado utiliza el bloqueo transaccional común de asistencia/eliminación y vuelve a comprobar la cuenta antes de escribir. Las pruebas de persistencia usan dobles de base de datos y procesamiento real de imágenes, sin subir fotos ni modificar cuentas reales.

## Datos y cuentas

`config/middlewares.js` debe incluir `DELETE` en `strapi::body.config.parsedMethods`, conservando `POST`, `PUT` y `PATCH`. Sin esa configuración, Strapi descarta el cuerpo de la confirmación y rechaza la eliminación aunque el correo coincida. Esta carpeta conserva también la configuración de referencia del middleware.

La eliminación administrativa de cuentas se implementa en `team-deletion`, con revisión `GET /team-admin/employees/:documentId/deletion` y confirmación `DELETE /team-admin/employees/:documentId`. Elimina cuenta de acceso completa (también Backstage), perfil con sus secretos temporales y todas las llegadas vinculadas. Los registros antiguos por nombre requieren selección explícita. La identidad y el administrador se vuelven a validar dentro de la transacción, con el bloqueo asesor de asistencia y bloqueos de empleado/cuenta; se rechaza la autoeliminación. Un fallo revierte el conjunto. El servicio nativo `users-permissions.user.remove` retira la cuenta e invalida sus sesiones administradas. Los detalles de uso están en `team/README.md` del frontend.

Se añade `api::team-employee.team-employee`, tabla `team_employees`, sin Draft & Publish ni localización. Los empleados se mantienen desde Team, por lo que el modelo no aparece en Content Manager ni Content Type Builder. No hay rutas REST genéricas de empleados; existen operaciones administrativas específicas con autenticación y política de autorización, y validaciones/confirmaciones públicas limitadas a los códigos temporales de alta.

| Campo | Origen y comportamiento |
| --- | --- |
| `documentId` | Identificador estable generado por Strapi. |
| `fullName` | Nombre completo, obligatorio, conserva mayúsculas y acentos. |
| `startDate` | Fecha de ingreso, obligatoria, fecha de calendario `AAAA-MM-DD`. |
| `phone` | Teléfono obligatorio normalizado con prefijo internacional `+`. Los números mexicanos de diez dígitos reciben `+52`. |
| `position` | Puesto laboral obligatorio. Distintas personas pueden compartirlo. |
| `teamRole` | `employee` (Servicio), `operative` (Operativo), `production` (Producción) o `admin`, con `employee` como valor inicial. Independiente del puesto y del rol de Backstage. Operativo no registra asistencia, no aparece en la lista de asistencia y no tiene cuenta de pago ni acceso a sus ajustes o cálculos. Los registros previos se conservan. |
| `status` | `invited`, `active` o `inactive`. Todo perfil nuevo comienza `invited`. |
| `account` | Relación privada uno a uno con una cuenta existente de Users & Permissions. |
| `invitationTokenHash` | Huella SHA-256 privada del código temporal; no se conserva el código original. |
| `invitationExpiresAt` | Vencimiento privado de la invitación, 72 horas después de generarla. |
| `invitationCancelled` | Indicador privado del estado actual de cancelación, `false` por defecto. No es un historial. |
| `invitationAccepted` | Indicador privado de aceptación, `false` por defecto. Cierra el código actual sin activar la cuenta ni crear historial. |
| `activationTokenHash` | Huella SHA-256 privada del único código vigente de activación. Se elimina al cancelar o activar. |
| `activationExpiresAt` | Vencimiento privado de activación, 24 horas después de generar. |
| `personalTokenHash` | Campo privado/único anterior, sin autorización desde la corrección del 28/10/2026. El check-in ya no lo consulta. |
| Email y contraseña | Pertenecen únicamente a la cuenta de Users & Permissions; no se duplican en el empleado. El perfil lee el email actual de la cuenta. |

El registro administrativo crea o reutiliza la cuenta de Users & Permissions antes de vincular el perfil. Una cuenta nueva queda sin confirmar y sin contraseña, con el rol específico `teamemployee`, creado sin permisos. Una cuenta local preexistente conserva su contraseña, estado de confirmación y rol. Se rechazan emails ambiguos, cuentas bloqueadas, cuentas de otros proveedores y vinculaciones repetidas. El email se normaliza a minúsculas.

`src/team-config.js`, ejecutado al principio del bootstrap de la aplicación, asegura el rol base y establece `allow_register: false` sin alterar los demás ajustes de autenticación. La configuración es idempotente y no sobrescribe permisos de roles existentes. El registro público de cuentas queda cerrado; no se modifican las cuentas existentes. `config/database.js` usa `debug: false` para no imprimir datos de empleados o credenciales en consultas SQL.

## Servicio interno

`strapi.service('api::team-employee.team-employee')` expone:

- `createForAccount(accountId, details)`: valida y crea un perfil para una cuenta existente. Rechaza una segunda vinculación.
- `updateForAccount(accountId, changes)`: actualiza campos del mismo documento. Permite cambios parciales de datos laborales y rol de Team, sin crear copias del perfil.
- `findForAccount(accountId)`: devuelve el perfil asociado, o `null` si no existe.

Los métodos de escritura usan una transacción y bloquean la fila de la cuenta (`SELECT ... FOR UPDATE`) antes de consultar y modificar el perfil. Esto serializa dos solicitudes simultáneas para la misma cuenta. Deben usarse estos métodos para crear y editar perfiles, no escrituras directas que eviten ese control.

El servicio interno de datos laborales no acepta email, contraseña, vinculación ni activación. El email y el estado de acceso se gestionan desde el servicio administrativo transaccional del paso 7; la contraseña y la vinculación no se modifican desde ese formulario. El servicio de empleados no escribe en Users & Permissions ni concede acceso a Backstage.

**El servicio interno no autentica al solicitante.** Los controladores administrativos están protegidos por `api::team-employee.team-admin`: exige una cuenta confirmada y no bloqueada y permite al administrador inicial `backstageadmin` o a un empleado activo con rol de Team `admin`. Un perfil inactivo se rechaza también para el administrador inicial. El DTO del perfil usa una lista explícita de campos y excluye cuenta anidada, contraseña y tokens.

`strapi.service('api::team-employee.team-registration')` ofrece `list(page)` y `prepareInvitation(input)`. La creación usa una transacción y un bloqueo asesor por email normalizado, además del bloqueo por cuenta del servicio de empleados. Una cuenta, su perfil y la invitación se confirman juntos o se revierten juntos. El listado usa páginas de 25 empleados y nunca devuelve la huella del código.

Las rutas del CMS son `GET /api/team-admin/session`, `GET /api/team-admin/employees` y `POST /api/team-admin/employees`. Admiten únicamente la estrategia `users-permissions`; los API tokens no sustituyen la sesión. Usan handlers de función: con handlers de texto, el `defaultsDeep` de Strapi rellena incluso un `scope: []` e introduce un permiso de acción no deseado. Las funciones conservan el scope vacío y delegan expresamente la autorización a la política de Team, que rechaza solicitudes sin usuario incluso si el rol público tiene permisos de otras colecciones. Next conserva el JWT en su cookie HttpOnly y llama estas rutas en servidor.

La invitación usa un código aleatorio de 256 bits que se devuelve solo al crearlo o regenerarlo. Next construye `/team/invitacion/abrir#token=...`, manteniendo el secreto fuera del path HTTP. La aceptación de un solo uso y el guardado de contraseña funcionan desde el paso 5. La cuenta se activa al aceptar la invitación y guardar/probar sus credenciales; no se envían mensajes ni correos automáticos. El acceso diario ahora requiere sesión; asistencia semanal y conservación de registros están implementadas y se describen abajo.

## Gestión y validación de invitaciones (paso 4)

`strapi.service('api::team-employee.team-invitation')` expone `validate(token)`, `accept(input)`, `cancel(documentId)` y `regenerate(documentId)`. Las escrituras bloquean la fila del empleado dentro de una transacción y rechazan perfiles que no estén pendientes, cuentas bloqueadas o relaciones inexistentes. No crean otro usuario, perfil ni registro de invitación.

- `POST /api/team-admin/employees/:documentId/invitation/cancel`: usa la misma autenticación y política administrativa. Marca la invitación actual como cancelada; es idempotente y no borra ni bloquea la cuenta. Conserva la huella para identificar el enlace como cancelado, sin autorizar su uso.
- `POST /api/team-admin/employees/:documentId/invitation/regenerate`: usa la misma autenticación y política. Reemplaza la huella y el vencimiento, restablece la cancelación y devuelve el nuevo código una sola vez. Los códigos previos quedan desconocidos; no se guardan versiones anteriores.
- `POST /api/team-invitations/validate`: no exige sesión. Recibe únicamente el código en el cuerpo; lo busca mediante su huella y devuelve `pending`, `accepted`, `expired`, `cancelled` o `invalid`. Solo en estado pendiente incluye los cinco datos de revisión (nombre, ingreso, teléfono, puesto y email), el modo de contraseña, el vencimiento y los segundos restantes calculados en servidor. No devuelve rol, ID de cuenta, huellas ni credenciales. Los demás estados no exponen el perfil. Es de solo lectura y no consume el código.

La validación pública usa el limitador del plugin Users & Permissions, configurado en 60 solicitudes por minuto por IP/ruta. Un middleware anterior conserva solo `body.token`, evitando que un campo `email` arbitrario cambie la clave del limitador. Las respuestas usan `Cache-Control: no-store` y `Referrer-Policy: no-referrer`. Next no envía la cookie administrativa ni un JWT al validar el código.

El listado administrativo calcula `invitationStatus` (`pending`, `accepted`, `expired`, `cancelled`, `missing`, `unavailable`) con la hora del servidor. En la pantalla del destinatario, el fragmento se conserva al navegar por teclado; se vuelve a validar cuando cambia, al recuperar foco y al transcurrir los segundos restantes indicados por el servidor. Ni la validación ni la cancelación activan la cuenta o cambian su contraseña.

## Aceptación de invitaciones (paso 5)

`POST /api/team-invitations/accept` es público, sin JWT ni sesión. Admite únicamente código, modo de contraseña, contraseña/confirmación o contraseña actual y revisión confirmada. El middleware descarta los demás campos antes del limitador (10 intentos por cinco minutos por IP/ruta), evitando aliases con `email`. Devuelve únicamente `{status: 'accepted', activationRequired: true}` con `no-store` y `no-referrer`.

El servicio valida el cuerpo, busca por SHA-256 y bloquea la fila del empleado; vuelve a comparar la huella y el estado bajo el bloqueo, y bloquea la cuenta. Por indicación de Fredy, las contraseñas nuevas no tienen mínimo de longitud ni reglas de complejidad: solo deben estar presentes y coincidir exactamente con su confirmación, sin recortar espacios. Se conserva únicamente el máximo técnico de 72 bytes UTF-8 de bcrypt. `users-permissions.user.ensureHashedPasswords` aplica el hash una sola vez y el Query Engine guarda ese hash y la confirmación dentro de la misma transacción; este flujo evita el mínimo global de seis caracteres de Document Service sin cambiar las políticas de otros flujos. Para cuentas con contraseña verifica la actual y conserva el hash y el rol. El generador opcional del frontend usa 20 caracteres uniformes mediante Web Crypto y falla si no está disponible.

Vuelve a comprobar el vencimiento después del guardado, y marca `invitationAccepted` en la misma transacción. Una excepción revierte también el hash. Los intentos concurrentes se serializan: solo uno puede consumir el código. Cancelar o regenerar una invitación aceptada devuelve conflicto. Se conserva exclusivamente la huella actual para mostrar el estado cerrado; no permite volver a consultar el perfil ni crea un historial. El empleado sigue `invited`; una cuenta nueva sigue sin confirmar. No se envía email, no se activa la cuenta y no se inicia sesión: la activación es el paso 6.

## Activación integrada en la aceptación (28/10/2026)

`team-invitation.accept(input)` valida revisión de datos, contraseña y código vigente; bloquea empleado/cuenta y, en la misma transacción, guarda la contraseña mediante Users & Permissions, confirma la cuenta y actualiza `status: active`. Para cuentas existentes valida su contraseña actual y conserva su hash y roles; confirma la cuenta solo si todavía no lo estaba. Devuelve exclusivamente `{ status: 'activated' }`, sin JWT ni sesión automática. Next proyecta esa respuesta; la pantalla ofrece iniciar sesión.

La invitación se consume borrando su SHA-256 y vencimiento, junto con cualquier código anterior de activación. Se conserva únicamente el estado actual `invitationAccepted: true`. Un reintento/replay falla, dos aceptaciones simultáneas permiten una sola y un fallo de persistencia o vencimiento durante el guardado revierte contraseña, confirmación y perfil juntos.

El paso separado se retiró: `routes/activations.js` no registra rutas; los proxies Next de validación, confirmación y generación/cancelación responden 410; `/team/activar` conduce al login. Administración no genera ni aprueba activaciones. Los campos anteriores de activación permanecen privados por compatibilidad, sin autorización pública.

`team-onboarding-config.js` ejecuta en bootstrap una transición idempotente de perfiles que ya tenían `status: invited` e `invitationAccepted: true` del flujo previo. `completeAccepted(documentId)` vuelve a bloquear y verificar cuenta local disponible con contraseña; confirma y activa sin cambiar su hash, datos o roles, y descarta los códigos anteriores. No activa invitaciones sin aceptar, cuentas bloqueadas/sin contraseña ni perfiles inactivos. Repetir el arranque no vuelve a tocar perfiles activos. Esta transición se necesitaba para una cuenta existente que ya había guardado sus credenciales.

## Sesión y mantenimiento (paso 7)

- `GET /api/team/session`: autenticación Users & Permissions y política `team-member`. Devuelve identidad mínima, `canAdmin` y perfil explícito propio (o `null` para la cuenta administrativa inicial sin perfil activo).
- `GET /api/team/profile`: misma política; perfil del usuario autenticado únicamente, sin aceptar identificadores de otro empleado. Sin perfil activo devuelve 404 para la cuenta inicial.
- `PATCH /api/team-admin/employees/:documentId`: política `team-admin`; recibe solo datos laborales, email, rol de Team y estado activo/inactivo. El controlador obtiene el actor desde `ctx.state.user.id`.

La política de miembro exige cuenta confirmada/no bloqueada y empleado activo; permite la excepción administrativa inicial sin perfil activo, pero rechaza cualquier perfil inactivo. La política administrativa sigue separada. Todas las rutas usan handlers de función y scope vacío con estrategia obligatoria, sin dar permisos genéricos al rol `teamemployee`. Un empleado puede leer únicamente su perfil y no puede editar su rol, datos laborales o los de otra persona.

`team-maintenance.update(documentId, input, actorId)` bloquea empleado y cuenta, comparte el bloqueo asesor por email del registro y comprueba unicidad sin distinguir mayúsculas (incluidos usuarios de otras cuentas). Actualiza el email mediante el servicio de Users & Permissions, los datos del mismo empleado y devuelve un DTO explícito. Un fallo revierte ambas partes. No cambia contraseña, confirmación, vínculo ni rol de Users & Permissions; no crea registros ni versiones. El estado solo se modifica cuando el alta ya se completó; una cuenta bloqueada no se reactiva desde Team. El actor no puede desactivarse ni cambiar su propio rol.

Next conserva una cookie y JWT de Team de 400 días renovables, sin refresh tokens ni tablas de sesiones. `POST /api/team/session/renew`, con política `team-member`, emite el JWT mediante el servicio de Strapi con `{ expiresIn: "400d" }`, sin modificar la configuración global del plugin ni Backstage. El login y la API de sesión de Next renuevan la credencial y la cookie, sin devolver JWT al JavaScript. Un navegador puede eliminar cookies antes del vencimiento; tras 400 días sin renovación hace falta login. `/team/login` y la API de sesión aceptan empleados activos; las APIs administrativas mantienen su política. El servidor decide el acceso según el estado/rol actual en cada petición. Logout elimina la cookie de Team y no cambia Backstage; un JWT copiado sigue sujeto a su vencimiento y a las políticas del CMS. Los proxies privados son `no-store`/`no-referrer` y las mutaciones requieren Origin del mismo sitio.

## Enlace personal retirado (reemplaza el paso 8)

Fredy cambió el acceso el 28 de octubre de 2026: bienvenida, perfil y check-in requieren sesión activa. Se cerraron todas las rutas de `routes/personal-access.js` y la ruta pública anterior de check-in. Las huellas anteriores siguen privadas, pero ya no autorizan ninguna ruta. No se generan enlaces personales en la UI; el proxy Next anterior responde 410. La invitación temporal sigue funcionando sin login y completa directamente la activación.

`GET /api/team/welcome` y `POST /api/team/checkin` exigen Users & Permissions y política `team-member`, con handlers de función para no introducir scopes genéricos. Los controladores usan `ctx.state.user.id`; el cliente no elige empleado ni cuenta. Un administrador sin perfil activo puede gestionar el equipo, pero no registrar una llegada.

## Asistencia y retención (paso 9)

Nuevo modelo `api::team-checkin.team-checkin` (`team_checkins`), sin versiones ni rutas genéricas. Campos: relación privada requerida al empleado, `dayKey` privado/único (documentId+fecha), `date`, `timestamp` y `punctual`. Solo guarda una llegada por empleado/día; no almacena coordenadas ni snapshots del perfil.

`team-attendance.record(accountId, input)` recibe únicamente el ID de la cuenta autenticada del controlador y valida su empleado activo, comprobación HMAC de dos minutos ligada a cuenta/empleado/día, coordenadas/precisión y distancia de 70 m; toma fecha y hora del servidor en Ciudad de México. Cierra desde 12:00:00 y clasifica puntual solo antes de 08:05:59. Las respuestas vuelven a calcular la puntualidad desde el timestamp, sin reescribir los booleanos antiguos. Transacción, bloqueo asesor común y bloqueos de empleado/cuenta serializan duplicados y revocación. El segundo intento devuelve `already_registered` sin cambiar hora. La única inyección de reloj es una dependencia interna del servicio para pruebas; no existe bypass ni fecha configurable desde HTTP.

- `POST /api/team/sick`: JWT y política `team-member`, máximo 10/minuto por IP/ruta. Recibe solo `{}`; usa la identidad autenticada y la fecha/hora de recepción del servidor. Guarda `kind=sick`, `punctual=false` sin GPS, challenge ni validación de horario. Comparte transacción, bloqueos y clave diaria con la llegada normal: devuelve el registro existente sin sobrescribirlo. Next expone esta acción en `/api/team/access/sick`; la semana personal y administrativa muestran «Enfermedad». No escribe pagos ni datos médicos.
- `POST /api/team/checkin`: JWT y política `team-member`, máximo 10/minuto por IP/ruta. Rechaza identidad, códigos personales, fecha, puntualidad y flags del cliente; revalida cuenta/empleado bajo bloqueo y solo usa el ID de sesión.
- `GET /api/team-admin/checkins`: JWT/política administrativa, páginas de 25 empleados y registros anteriores; filtra la semana del servidor aunque el cliente solicite otras fechas.
- `POST /api/team-admin/checkins/legacy/:documentId/link`: administrador selecciona explícitamente un empleado. Crea la llegada vinculada y elimina el documento anterior juntos; no sobrescribe un día ocupado ni asigna por nombre.

`welcomeForAccount(accountId)` solo consulta las siete fechas de la semana actual y la persona autorizada; devuelve estados on_time/late/no_record/upcoming y las horas. No infiere faltas. La bienvenida ya entrega `checkinState`, disponibilidad y challenge limitado. No expone email, GPS, roles ni identificadores a la bienvenida.

Desde el 30/10/2026, `team-attendance-config.js` conserva las asistencias: no llama a `purge()` ni registra cron de eliminación. No hay llamadas automáticas a `purge()` en el CMS. Las consultas siguen limitadas a la semana vigente mediante filtros, mientras los registros anteriores permanecen almacenados. Una prueba de regresión comprueba que bootstrap no accede al servicio de purga ni programa su ejecución.

El modelo anterior conserva solo la transición de registros vigentes y queda oculto en Content Manager/Builder, con sus rutas genéricas vacías. Su borrador/publicación no se usa para nuevas llegadas. Los dos documentos reales vigentes quedan para que Fredy seleccione su empleado, sin asignaciones automáticas. Las páginas antiguas del website redirigen a Team; no ejecutan el cliente anterior con nombre/skipLocation.

## Archivos instalados en el CMS

- `src/api/team-employee/content-types/team-employee/schema.json`
- `src/api/team-employee/routes/team-employee.js`
- `src/api/team-employee/services/team-employee.js`
- `src/api/team-employee/utils/employee-details.js`
- `src/api/team-employee/services/team-registration.js`
- `src/api/team-employee/controllers/team-admin.js`
- `src/api/team-employee/policies/team-admin.js`
- `src/api/team-employee/utils/invitations.js`
- `src/api/team-employee/utils/invitation-acceptance.js`
- `src/api/team-employee/utils/activations.js`
- `src/api/team-employee/services/team-activation.js`
- `src/api/team-employee/controllers/team-activations.js`
- `src/api/team-employee/routes/activations.js`
- `src/api/team-employee/routes/members.js`
- `src/api/team-employee/policies/team-member.js`
- `src/api/team-employee/controllers/team-member.js`
- `src/api/team-employee/services/team-maintenance.js`
- `src/api/team-employee/utils/personal-access.js`
- `src/api/team-employee/services/team-personal-access.js`
- `src/api/team-employee/controllers/team-personal-access.js`
- `src/api/team-employee/routes/personal-access.js`
- `src/api/team-employee/utils/attendance.js`
- `src/api/team-employee/services/team-attendance.js`
- `src/api/team-employee/controllers/team-attendance.js`
- `src/api/team-employee/routes/attendance.js`
- `src/api/team-checkin/content-types/team-checkin/schema.json` y rutas vacías
- `src/api/checkin/content-types/checkin/schema.json` y rutas vacías
- `src/team-attendance-config.js` y llamada en `src/index.js`
- `src/api/team-employee/services/team-invitation.js`
- `src/api/team-employee/controllers/team-invitations.js`
- `src/api/team-employee/routes/invitations.js`
- `src/team-config.js` y llamada desde `src/index.js`
- `config/database.js` (depuración SQL desactivada)
- `tests/team-employee.test.js`
- `tests/team-registration.test.js` y adaptación del mock de bootstrap en `tests/sortable-entries.test.js`
- `tests/team-invitation.test.js`
- `tests/team-activation.test.js`
- `tests/team-member.test.js`
- `tests/team-personal-access.test.js`
- `tests/team-attendance.test.js`
- `types/generated/contentTypes.d.ts` (actualizado automáticamente por Strapi)

La instalación del paso 2 añadió la carpeta de la API como una unidad completa. El paso 3 amplió sus archivos, añadió los dos campos privados e integró la configuración de cuentas sin reemplazar la lógica previa del bootstrap. El arranque de Strapi sincroniza el esquema completo de ese CMS; los efectos se verificaron contra PostgreSQL real. No volver a copiar el paquete sobre la implementación activa sin comparar cambios.

## Pruebas sin base de datos

Desde `generoso-cms`:

```sh
node --test tests/team-*.test.js
```

Desde `../generoso-management`: `node --test team/tests/admin-api.test.mjs`.

Las 78 pruebas de Team usan las dependencias ya instaladas del CMS. Incluyen el validador real de modelos y entidades de Strapi 5.59.0 y el registro real de rutas, con persistencia simulada; no arrancan Strapi ni leen `.env`. Cubren validación, creación concurrente, rollback, política de acceso, configuración idempotente, huellas, exclusión de credenciales, ausencia de scopes de acción inyectados, vencimiento exacto, cancelación y regeneración. Las 41 pruebas de Next cubren cookies, Origin, autorización, validación pública sin sesión, respuestas mínimas, fallos del CMS y formato del enlace.

Desde el CMS, ejecutar `node --test tests/team-employee.test.js tests/team-registration.test.js tests/team-invitation.test.js tests/team-activation.test.js tests/team-member.test.js tests/team-personal-access.test.js tests/team-attendance.test.js tests/sortable-entries.test.js`: las 82 pruebas pasan.

## Evidencia de las etapas anteriores (el acceso sin login fue reemplazado)

- PostgreSQL contiene las dos tablas nuevas; no se eliminó ninguna tabla preexistente.
- El proceso del CMS carga el servicio y el modelo; `/_health` responde 204.
- `/api/team-employees` y `/api/team-employees/1` responden 404, sin rutas genéricas públicas. Las nuevas rutas administrativas responden 403 sin usuario; el proxy de Next responde 401 sin cookie.
- Una comprobación adicional del paso 3 cargó registros y metadatos de Strapi sin ejecutar bootstrap ni otra sincronización. Dentro de una transacción real, preparó una cuenta y una invitación, validó la huella, el listado, la falta de contraseña, el rol sin permisos y el rechazo de duplicados. Comprobó también la política de acceso con perfiles pendientes, activos y cuentas bloqueadas, y que el registro público esté cerrado. Pasaron 16 aserciones.
- La comprobación forzó rollback de toda la transacción. Los conteos de cuentas y empleados antes y después coincidieron; no se conservaron usuarios ni perfiles de prueba.
- En los pasos 2–4, la concurrencia se cubrió con persistencia simulada. No se usaron contraseñas reales del administrador para probar el formulario en el navegador. Se comprobó visualmente la redirección al login y se probaron las APIs de Next con respuestas controladas del CMS.
- Tras corregir la inyección de scopes en las rutas, se verificó por HTTP la identidad del administrador existente mediante una credencial interna de diagnóstico de 30 segundos, sin guardarla ni cambiar la contraseña o el rol. Las consultas de sesión y empleados del CMS, la sesión de Next y el render del formulario de `/team/admin` respondieron 200; una consulta anónima siguió recibiendo 403.
- El paso 4 se verificó además mediante 43 comprobaciones HTTP contra Next y el CMS: código vigente, lectura repetida sin consumo, regeneración y sustitución del anterior, cancelación idempotente, reemisión tras cancelación, vencimiento, listado y rechazo de mutaciones sin sesión, de otro origen o sobre un perfil activo. Solo se modificó una cuenta temporal de prueba y su perfil, eliminados al terminar. Los conteos de cuentas, empleados y check-ins volvieron a su valor inicial; las invitaciones reales existentes no se modificaron.

- El paso 5 pasó 54 comprobaciones adicionales contra Next, el CMS y PostgreSQL reales: revisión limitada, contraseña débil rechazada, hash validado con Strapi, consumo único, dos solicitudes simultáneas con un solo éxito, comprobación de contraseña existente sin cambiar su hash/confirmación/rol, rollback real del hash ante fallo al consumir y rechazo de enlaces cancelados/vencidos. Se eliminaron todas las cuentas y perfiles temporales; los conteos volvieron a 2 cuentas, 1 empleado y 4 check-ins. El navegador mostró el formulario con datos temporales y campos de contraseña vacíos; la entrada y envío de credenciales se probaron mediante HTTP.

- Validación del paso 6: 54 pruebas del CMS y 19 de Next pasan. Se completaron 78 comprobaciones contra las APIs y PostgreSQL reales: alta aceptada como requisito, protección administrativa y de Origin, generación/sustitución/cancelación, vencimiento, lectura sin consumo ni datos personales, activación de cuenta y empleado juntos, rechazo de reutilización, dos confirmaciones simultáneas con un solo éxito, reversión real de la confirmación si falla el perfil y conservación de contraseña/roles. Todas las cuentas y perfiles temporales fueron eliminados; los conteos iniciales y finales coinciden (2 cuentas, 1 empleado, 4 check-ins). El navegador mostró el enlace pendiente y el botón; la confirmación se probó por HTTP. Compilación y tipos correctos, lint sin errores y con siete advertencias previas. Se reinició el entorno local para limpiar una exportación obsoleta en memoria de Turbopack; no hubo un despliegue.

- Validación del paso 7: 66 pruebas instaladas del CMS y 27 de Next pasan; compilación y tipos correctos, lint con cero errores y las siete advertencias previas. Se completaron 66 comprobaciones contra las APIs y PostgreSQL reales: rechazo de pendientes, login de empleado, perfil y SSR propios sin IDs ajenos, protección administrativa y de Origin, email nuevo con contraseña/rol preservados, rechazo de duplicados, reversión real del email ante fallo laboral, concurrencia por email, desactivación/reactivación, cambio inmediato del rol de Team, prevención de cambios propios de acceso y logout separado de Backstage. En navegador se inició sesión con usuario/contraseña de una cuenta temporal ya creada, se revisaron los cinco datos, se cerró sesión y se comprobó que volver al perfil exige login. Todas las cuentas y empleados temporales se eliminaron: conteos iniciales/finales de 2 cuentas, 1 empleado y 4 check-ins. No hubo despliegue ni cambios en credenciales reales.

- Validación del paso 8: 78 pruebas instaladas del CMS y 35 de Next pasan, con compilación/tipos correctos y lint sin errores (siete advertencias previas). Se completaron 82 comprobaciones sobre APIs y PostgreSQL reales: generación administrativa, nombre mínimo sin sesión, cookie limitada y navegación, ausencia de secretos en HTML GET, rechazo de perfil/admin con el código personal, sustitución/cancelación, dos generaciones concurrentes con un solo código vigente, cuentas bloqueadas/no confirmadas, desactivación que borra la huella y reactivación que no restaura el código, conservación de credenciales/roles y cero llegadas al abrir. En navegador se verificó bienvenida sin login, mismo nombre en check-in, perfil redirigido a login y regreso a Mi inicio sin perder el acceso. Se eliminaron todos los perfiles/cuentas temporales; los conteos regresaron a 2 cuentas, 1 empleado y 4 check-ins. No se publicó un despliegue ni se modificó la asistencia existente.

- Validación del paso 9: 90 pruebas instaladas del CMS y 41 de Next pasan. Compilación y tipos correctos; lint sin errores, con siete advertencias anteriores. Se completaron 57 comprobaciones reales de APIs/PostgreSQL: ubicación distante/imprecisa rechazada, challenge de otro empleado rechazado, datos de identidad/hora/bypass no aceptados, dos solicitudes simultáneas con un solo registro, reintento idempotente, límite de las 09:00 con reloj controlado, rollback real de una inserción fallida, consulta privada de semana actual, vinculación manual sin duplicar, retención que elimina fechas fuera de semana y conserva las vigentes, cierre de rutas genéricas y redirecciones anteriores. El registro positivo por HTTP usó coordenadas simuladas del restaurante y hora real del servidor; no se simuló el reloj en la ruta pública. En navegador se verificaron Check-in registrado y los estados/horas semanales del empleado temporal. Queda por hacer la prueba presencial de permisos/precisión GPS en un teléfono real. Todas las cuentas y registros temporales se eliminaron; quedaron 2 cuentas, 1 empleado, 2 documentos anteriores reales y 0 llegadas de Team. Los documentos reales mantienen sus valores; previamente se retiraron únicamente sus dos copias de publicación, sin vincularlos automáticamente. No se desplegó.

## Validación de la corrección del 28/10/2026

Pasan 82 pruebas instaladas del CMS (78 de Team y 4 de ordenación) y 39 de Next, con tipos correctos y lint sin errores (siete advertencias previas). Se completaron 48 comprobaciones sobre APIs y PostgreSQL reales: redirección anónima, rutas públicas retiradas, rechazo de la cookie/código personal, login y renovación con JWT/cookie de 400 días, aislamiento de permisos por cuenta, check-in solo del propio empleado, idempotencia concurrente, cierre horario real, cambio de rol e inactivación con sesión existente, y configuración global de JWT intacta. El registro positivo usó únicamente un reloj interno de pruebas a las 08:00 y coordenadas simuladas; la ruta HTTP mantuvo la hora real posterior a las 09:00 y rechazó una nueva llegada. No hay bypass público del reloj.

En navegador se verificaron login inicial sin Equipo/Vista previa, login de empleado hacia su dashboard, semana propia, perfil y logout de vuelta al login. Se eliminaron las dos cuentas/perfiles y llegadas temporales: los conteos regresaron a 2 cuentas, 1 empleado, 2 llegadas anteriores y 0 nuevas de Team. Los registros reales anteriores conservaron sus valores. Sigue pendiente la prueba presencial del GPS en teléfono. No se desplegó.

La compilación de producción se comprobó con `next build --webpack`. `next build` con Turbopack falla en este entorno al intentar enlazar su puerto interno (EPERM); no se modificó el compilador predeterminado del proyecto.

## Validación de la activación integrada (28/10/2026)

Pasan 76 pruebas instaladas del CMS (72 de Team y 4 de ordenación) y 35 de Next, con tipos y lint de Team correctos. Compilación de producción verificada con Webpack. Se completaron 55 comprobaciones reales de APIs/PostgreSQL: alta sin contraseña, activación inmediata al aceptar, códigos descartados y replay rechazado, login/perfil/bienvenida accesibles después, comprobación de contraseña existente sin alterar su hash/rol, dos aceptaciones concurrentes con un solo éxito y rollback real después de escribir la activación, que restaura contraseña vacía, confirmación falsa e invitación pendiente. Rutas separadas retiradas y administración sin controles de activación. Se reinició el entorno local para descartar una exportación antigua de Turbopack.

Bootstrap completó la única cuenta real que ya tenía invitación aceptada y credenciales guardadas; mantiene su perfil, contraseña y roles. No se activó ninguna invitación sin aceptar. Se eliminaron las cuatro cuentas/perfiles temporales; quedaron 2 cuentas, 1 empleado, 2 llegadas anteriores y 0 llegadas nuevas de Team, sin alterar la asistencia real. No se desplegó.

## Listado de invitaciones separado (28/10/2026)

`team-registration.list(page, status)` mantiene el listado completo por defecto y admite únicamente el filtro opcional `invited`. `GET /api/team-admin/employees?status=invited` usa la misma política administrativa y aplica `filters: { status: 'invited' }` tanto a la consulta paginada como al conteo. Otros valores se rechazan. Next usa ese filtro para `/team/admin/invitaciones`; no se crean tablas ni registros adicionales y no cambia el alta/aceptación.

Validación de la separación de secciones: 11 pruebas de registro/CMS y 36 de APIs Next pasan. Tipos y lint de Team correctos; build de producción con Webpack correcto. Navegación y contenido independiente de Equipo, Invitaciones y Check-ins comprobados en Chrome. Acceso anónimo redirige al login conservando cada destino y la API de invitaciones devuelve 401 sin sesión. No se crearon invitaciones ni se modificaron empleados/asistencia para esta verificación.
