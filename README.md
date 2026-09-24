# Strapi example

This example deploys self-hosted version of [Strapi](https://strapi.io/). Internally it uses a PostgreSQL database to store the data.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/strapi?referralCode=milo)

## ✨ Features

- Strapi
- Postgres

## 💁‍♀️ How to use

- Click the Railway button 👆
- Add the environment variables
- Media will automatically be persisted between deploys!

## 💻 Developing locally

When developing locally this Strapi template will connect to the Postgres server from its public [TCP Proxy](https://docs.railway.app/deploy/exposing-your-app#tcp-proxying)

- Enable the feature flag `Template Service Eject` in the [Feature Flags](https://railway.app/account/feature-flags) menu
- Within the service settings of the Strapi service click the `Eject` button on the upstream repository
- Clone that newly created repository locally
- Install Strapi's dependencies with `yarn install` or `npm install`
- Install the Railway CLI
    - Instructions for that can be found [here](https://docs.railway.app/develop/cli#installation)
    - If this is your first time using the CLI make sure to login with `railway login`
- Within the local repository run `railway link` to link the local repository to the Strapi service on Railway
- Start Strapi for development with `railway run yarn run develop` or `railway run npm run develop`
    - This command will run Strapi in development mode with the service variables available locally
- Open your browser to `http://127.0.0.1:1337/admin`

## 📝 Notes

- After your app is deployed, visit the `/admin` endpoint to create your admin user.
- If you want to use npm with this project make sure you delete the `yarn.lock` file after you have ran `npm install`

## Daily Checklist

El módulo usa únicamente el collection type `checklist-task`. Cada registro guarda su propia fecha, turno y estado (`taskStatus`); no existen ejecuciones ni relaciones auxiliares.

`completedOn` es una fecha opcional que registra cuándo se marcó terminada una tarea por intervalo (zona `America/Mexico_City`). El frontend agenda desde esa fecha y ajusta la programación desde la revisión cuando esta ocurre dos o más días calendario después. Desplegar este esquema antes del frontend; Strapi sincroniza el campo nuevo al arrancar. Los registros existentes pueden conservarlo vacío: al revisarlos, el frontend agenda desde la revisión sin inferir cuándo se terminaron.

La migración `database/migrations/202607200002-reset-daily-checklist.js` elimina intencionalmente las tablas y datos del Daily Checklist anterior. Al iniciar Strapi, se crea la colección nueva vacía.
