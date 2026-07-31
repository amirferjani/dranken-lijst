# Frigo AI – dranken-lijst

Mobiele webapp voor cafévoorraad:

- Neem 1–20 foto's van dezelfde frigo op een iPhone.
- OpenAI Vision bekijkt alle foto's samen en probeert dubbeltellingen te vermijden.
- Leer één keer de volle/doelvoorraad per frigo aan.
- Bereken automatisch hoeveel flessen per product ontbreken.
- Corrigeer de telling voor het afdrukken.
- Print een 72 mm-aanvulticket via Star PassPRNT op een TSP100IIILAN.

## Printer die al is ingesteld

- Model: `TSP100IIILAN`
- Interface: LAN
- IP: `192.168.0.36`
- PassPRNT-port: `TCP:192.168.0.36`
- Printbreedte: 576 dots / ongeveer 72 mm

## Veiligheid

De OpenAI API-key hoort **nooit** in `index.html`, `app.js`, GitHub of de mobiele browser. De app gebruikt daarom een serverless API-route (`/api/analyze`) en leest de key alleen uit de servervariabele `OPENAI_API_KEY`.

Een API-key die ooit in een chat, screenshot of openbaar bestand is gedeeld, moet worden ingetrokken en vervangen.

## Online zetten met Vercel

1. Meld aan bij Vercel met GitHub en importeer `amirferjani/dranken-lijst`.
2. Voeg vóór **Deploy** bij **Environment Variables** toe:
   - `OPENAI_API_KEY` = een nieuwe OpenAI-projectkey
   - optioneel `OPENAI_MODEL` = `gpt-5-mini`
   - aanbevolen `APP_PIN` = een eigen toegangscode
3. Druk op **Deploy**. Vercel bouwt de statische mobiele pagina en de beveiligde `/api/analyze`-route.
4. Open de Vercel-link op de iPhone.
5. Bij gebruik van `APP_PIN`: vul dezelfde code in onder **Instellingen**.
6. Open in Safari → Deel → **Zet op beginscherm**.
7. Installeer/open Star PassPRNT en selecteer de printer op `192.168.0.36`.

## Lokaal testen

Met Vercel CLI:

```bash
vercel dev
```

Maak lokaal een `.env.local`:

```env
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5-mini
APP_PIN=
```

## Waarom eerst een volle frigo instellen?

Een foto toont wat er nu staat, maar niet hoeveel flessen er normaal horen te staan. In **Frigo instellen** fotografeer je daarom een volle/gewenste frigo. De herkende producten en aantallen worden lokaal op de iPhone opgeslagen. Bij iedere controle wordt `ontbreekt = doel - gezien` berekend.

## Nauwkeurigheid

AI kan geen volledig verborgen fles tellen. Voor de beste resultaten:

- fotografeer ieder rek recht van voren;
- neem overlappende foto's van links, midden en rechts;
- zorg dat doppen en etiketten zichtbaar zijn;
- vermijd sterke flitsreflecties;
- controleer regels met een lage zekerheid vóór het printen.


## Wat bewust niet in GitHub staat

- Geen OpenAI API-key.
- Geen `.env.local`.
- Geen Vercel-accounttoken.

De app toont bovenaan **AI-server klaar** zodra de online omgeving een geldige `OPENAI_API_KEY` heeft.
