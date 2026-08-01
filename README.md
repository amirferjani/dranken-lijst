# Frigo AI – dranken-lijst

Mobiele voorraadcontrole voor Café De Zoo. De app herkent dranken op 1–20 foto's, vergelijkt de telling met de doelvoorraad en maakt een aanvulticket voor een Star TSP100IIILAN.

De app kan na een Vercel-deployment rechtstreeks op een iPhone worden gebruikt. Voor de AI-route zijn altijd twee geheime servervariabelen nodig: `OPENAI_API_KEY` en `APP_PIN`.

## Wat er gekoppeld is

- **Kassacatalogus:** 260 producten uit `amirferjani/DLL_Injector`.
- **AI-analyse:** OpenAI Responses API via de serverroute `/api/analyze`; de API-key komt nooit in de browser of repository.
- **Mobiele app:** camera, fotobibliotheek, lokale frigo-instellingen en PWA-installatie vanaf Safari.
- **Printer:** Star PassPRNT naar `TCP:192.168.0.36`, 576 dots, partial cut.

## Kassacatalogus: live met lokale reservekopie

`/api/catalog` probeert de actuele catalogus uit de actieve kassabundel van `amirferjani/DLL_Injector` te lezen. De server bepaalt eerst de huidige commit, leest daarna `loader.js` en de zeven actieve `assets/app.full.*.b64`-delen, en bewaart het resultaat kort in het geheugen.

Als GitHub of de kassarepository tijdelijk niet bereikbaar is, gebruikt de app automatisch [`catalog.json`](catalog.json). Die meegeleverde snapshot bevat exact **260 producten** en is gemaakt uit commit `00a96d7cdbac7025fe48b2988a428124b8159dc4`. De app toont bij het instellen van een frigo of de lijst live is gesynchroniseerd of uit de ingebouwde reservekopie komt.

De snapshot handmatig vernieuwen met Node.js 24:

```bash
# Rechtstreeks vanaf de publieke kassarepository
node scripts/sync-catalog.mjs

# Reproduceerbaar vanaf een lokale checkout en benoemde broncommit
node scripts/sync-catalog.mjs ../DLL_Injector 00a96d7cdbac7025fe48b2988a428124b8159dc4
```

Controleer de wijziging in `catalog.json` altijd vóór commit. De CI haalt bewust geen live catalogus op: ze valideert de vastgelegde snapshot, exact 260 unieke product-ID's en de lokale tests zonder applicatienetwerkverkeer.

## Veiligheid

Gebruik nooit een API-key die in een chat, screenshot, browserbestand of Git-geschiedenis heeft gestaan. Trek zo'n sleutel in en maak een nieuwe OpenAI-projectkey.

`OPENAI_API_KEY` en `APP_PIN` zijn beide verplicht. Zonder een van beide weigert `/api/analyze` analyses. Kies voor `APP_PIN` een unieke, lange toegangscode (bij voorkeur minstens 16 tekens), deel ze alleen met het personeel en vul dezelfde code in onder **Instellingen** op ieder toegestaan toestel.

Bewaar deze waarden uitsluitend als Vercel Environment Variables of in een genegeerd lokaal `.env.local`-bestand. Zet ze nooit in `index.html`, `app.js`, `catalog.json` of GitHub. De toegangscode wordt op het toestel in lokale browseropslag bewaard; behandel een gedeelde of verloren iPhone daarom als een toestel met toegang tot de app.

## Online zetten met Vercel

1. Open [Vercel – New Project](https://vercel.com/new), meld aan met GitHub en importeer `amirferjani/dranken-lijst`.
2. Controleer dat de project-root de repository-root is en dat Vercel Node.js **24.x** gebruikt.
3. Voeg vóór **Deploy** onder **Environment Variables** toe:
   - `OPENAI_API_KEY`: een nieuwe OpenAI-projectkey;
   - `APP_PIN`: de unieke toegangscode voor het personeel;
   - optioneel `OPENAI_MODEL`: standaard `gpt-5.4-mini`.
4. Voeg de verplichte variabelen minstens toe aan **Production**. Voeg ze ook aan **Preview** toe als preview-deployments echt AI-analyses mogen uitvoeren.
5. Deploy de repository.
6. Controleer na deployment:
   - `/api/health` antwoordt met `configured: true`;
   - `/api/catalog` bevat 260 producten en meldt `source.mode` als `live` of `snapshot`;
   - de startpagina toont dat de AI-server is ingesteld en de kassalijst is gekoppeld.
7. Open de Vercel-link op de iPhone, vul onder **Instellingen** exact dezelfde `APP_PIN` in en bewaar de code.
8. Open de site in Safari en kies **Deel → Zet op beginscherm**.

Een health-check bevestigt alleen dat de twee verplichte servervariabelen aanwezig zijn. Voer na iedere sleutel-, model- of deploymentwijziging ook één echte testanalyse uit.

## Star TSP100IIILAN en PassPRNT

Voor deze installatie gebruikt de app:

- model: `TSP100IIILAN`;
- interface: LAN;
- IP-adres: `192.168.0.36`;
- PassPRNT-port: `TCP:192.168.0.36`;
- printbreedte: 576 dots, ongeveer 72 mm;
- snijmethode: partial cut.

Installeer Star PassPRNT op de iPhone en verbind de iPhone en printer met hetzelfde lokale netwerksegment. Selecteer of test de printer één keer in PassPRNT wanneer de app daarom vraagt. Gebruik daarna **Instellingen → Print testticket** in Frigo AI.

Frigo AI opent PassPRNT met `starpassprnt://v1/print/nopreview`. Na de print stuurt PassPRNT de browser terug met `passprnt_code` en `passprnt_message`. De app toont daarop succes of de concrete fout en verwijdert die callbackvelden uit de adresbalk. Code `0` betekent dat het ticket succesvol naar de printer is gestuurd. Controleer bij verbindingsfouten eerst voeding, papier, hetzelfde wifi/LAN-segment en het ingestelde IP-adres.

## Eerste gebruik

1. Open **Frigo instellen** en wacht tot de melding bevestigt dat 260 kassaproducten gekoppeld zijn.
2. Kies een bestaande frigo of geef een nieuwe frigo een naam.
3. Vul de frigo zoals ze normaal hoort te staan en neem overlappende foto's van ieder rek.
4. Laat AI de volle frigo herkennen. Controleer herkende, onzekere en onbekende producten en pas aantallen aan.
5. Sla de frigo en doelvoorraad op.
6. Open later **Controleren**, neem actuele foto's en start de analyse.
7. Corrigeer onzekere tellingen en print het aanvulticket.

Frigo's, doelvoorraden, printerinstellingen en de toegangscode blijven lokaal op het toestel staan. Gebruik **Instellingen → Exporteer back-up** om de frigo-instellingen veilig over te zetten. De back-up bevat niet de OpenAI API-key.

## Lokaal controleren met Node.js 24

Maak een lokale configuratie zonder waarden te committen:

```bash
cp .env.example .env.local
```

Vul `OPENAI_API_KEY` en `APP_PIN` alleen in `.env.local` in en start de Vercel-omgeving:

```bash
vercel dev
```

Dezelfde netwerkloze controles als CI:

```bash
find . -type f \( -name '*.js' -o -name '*.mjs' \) -not -path './.git/*' -print0 | xargs -0 -n1 node --check
node --test tests/*.test.mjs
```

De tests gebruiken Node's ingebouwde test-runner en hebben geen npm-pakketten, OpenAI-key, Vercel-account of live kassaverbinding nodig.

## Nauwkeurigheid

AI kan geen volledig verborgen fles betrouwbaar tellen. Voor de beste resultaten:

- fotografeer ieder rek recht van voren;
- neem overlappende foto's van links, midden en rechts;
- zorg dat doppen en etiketten zichtbaar zijn;
- vermijd sterke flitsreflecties;
- gebruik alleen foto's van dezelfde frigo en hetzelfde controlemoment;
- controleer regels met een lage zekerheid vóór het printen.

De berekening blijft `ontbreekt = max(0, doelvoorraad - gezien)`. Een AI-resultaat is een voorstel voor het barpersoneel, geen gegarandeerde fysieke telling.
