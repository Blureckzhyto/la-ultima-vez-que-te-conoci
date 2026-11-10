# Libro abierto

Lector web de ciencia ficción. La interfaz se puede publicar como sitio estático en GitHub Pages. Las cuentas, comentarios y el avance se conectan directamente a Supabase Auth y PostgreSQL con políticas RLS.

## Configurar Supabase (gratis para empezar)

1. Crea un proyecto en [supabase.com](https://supabase.com/).
2. En el panel del proyecto, abre **SQL Editor**, crea una consulta y ejecuta todo el contenido de `supabase-schema.sql`.
3. En **Project Settings > API**, copia la **Project URL** y la **publishable key** (o la antigua `anon` key). Pégalas en `supabase-config.js`.
4. En **Authentication > URL Configuration**, configura como **Site URL** `https://blureckzhyto.github.io/la-ultima-vez-que-te-conoci/` y añade esa misma URL a las URL permitidas de redirección.
5. En **Authentication > Providers > Email**, decide si quieres exigir confirmación de correo. Si está activada, el formulario informará al lector de que revise su correo después de registrarse.

La publishable/anon key está diseñada para aparecer en el navegador; las políticas RLS de `supabase-schema.sql` restringen el acceso. **Nunca copies la `secret` o `service_role` key en la web.**

## Publicar en GitHub Pages

1. Sube estos archivos a un repositorio GitHub. Mantén el repositorio privado mientras el manuscrito sea confidencial; para GitHub Pages con plan gratuito, la publicación desde un repositorio privado puede requerir un plan de pago. El capítulo publicado en la web será visible para los lectores.
2. En el repositorio abre **Settings > Pages**.
3. En **Build and deployment**, elige **Deploy from a branch**, la rama `main` y la carpeta `/ (root)`, y guarda.
4. GitHub mostrará la URL pública al terminar. Configúrala en Supabase como se indica arriba.

Cada cambio que subas a la rama publicada actualizará el sitio. Al añadir capítulos, actualiza `chapters.json` y `supabase-schema.sql` permite comentarios por número de capítulo.

## Probar localmente

Requiere Node.js 24 o posterior. Completa `supabase-config.js` y luego ejecuta:

```powershell
node server.mjs
```

Abre <http://127.0.0.1:4173>. El login y los datos usan Supabase también en local. El servidor conserva las rutas SQLite antiguas como modo de desarrollo anterior; la web ya no depende de esas rutas para cuentas o comentarios.

## Límites del plan gratuito

Supabase Free incluye base de datos, Auth y cuotas adecuadas para una primera versión; el proyecto puede pausarse tras una semana sin actividad. GitHub Pages sirve los archivos estáticos sin ejecutar un servidor Node.
