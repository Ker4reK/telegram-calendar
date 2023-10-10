import { Router } from 'itty-router';
import { Telegram } from './telegram';
import { Database } from './db';
import { processMessage } from './messageProcessor';
import { generateSecret, sha256 } from './cryptoUtils';

// Create a new router
const router = Router();
const handle = async (request, env, ctx) => {
	let telegram = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_USE_TEST_API);
	let db = new Database(env.DB);
	let corsHeaders = {
		'Access-Control-Allow-Origin': env.FRONTEND_URL,
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Max-Age': '86400',
	}

	let app = {telegram, db, corsHeaders};

	return await router.handle(request, app, env, ctx);
}

/*
Our index route, a simple hello world.
*/
router.get('/', () => {
	return new Response('This telegram bot is deployed correctly. No user-serviceable parts inside.', { status: 200 });
});

router.post('/initMiniApp', async (request, app) => {
	const {telegram, db} = app;
	let json = await request.json();
	let initData = json.initData;

	let {expectedHash, calculatedHash, data} = await telegram.calculateHashes(initData);

	if(expectedHash !== calculatedHash) {
		return new Response('Unauthorized', { status: 401, headers: {...app.corsHeaders } });
	}

	const currentTime = Math.floor(Date.now() / 1000);
	let stalenessSeconds = currentTime - data.auth_date;
	if (stalenessSeconds > 600) {
		return new Response('Stale data, please restart app', { status: 400, headers: {...app.corsHeaders } });
	}

	// Hashes match, the data is fresh enough, we can be fairly sure that the user is who they say they are
	// Let's save the user to the database and return a token

	let result = await db.saveUser(data.user, data.auth_date);
	let token = generateSecret(16);
	const tokenHash = await sha256(token);
	await db.saveToken(data.user.id, tokenHash);

	return new Response(JSON.stringify(
		{
			'token': token,
			'startParam': data.start_param,
	}),
		{ status: 200, headers: {...app.corsHeaders }});	
});

router.get('/miniApp/me', async (request, app) => {
	const {db} = app;

	let suppliedToken = request.headers.get('Authorization').replace('Bearer ', '');
	const tokenHash = await sha256(suppliedToken);
	let user = await db.getUserByTokenHash(tokenHash);

	if (user === null) {
		return new Response('Unauthorized', { status: 401 });
	}

	return new Response(JSON.stringify(
		{user: user}),
		{ status: 200, headers: {...app.corsHeaders }});	
});

router.post('/miniApp/dates', async (request, app) => {
	const {db, telegram} = app;

	let suppliedToken = request.headers.get('Authorization').replace('Bearer ', '');
	const tokenHash = await sha256(suppliedToken);
	let user = await db.getUserByTokenHash(tokenHash);

	if (user === null) {
		return new Response('Unauthorized', { status: 401 });
	}

	let ref = await generateSecret(8);
	let json = await request.json();
	let jsonToSave = JSON.stringify({dates: json.dates}); // todo: more validation
	if (jsonToSave.length > 4096) { return new Response('Too much data', { status: 400 }); }

	await db.saveCalendar(jsonToSave, ref, user.id);

	let result = await telegram.sendMessage(user.telegramId, "Your calendar is ready and available for share using [this link](https://t.me/group_meetup_bot/calendar?startapp="+ ref +")\\. Send it to your friends so that they can choose a date\\.", 'MarkdownV2');
	console.log(result);

	return new Response(JSON.stringify(
		{user: user}),
		{ status: 200, headers: {...app.corsHeaders }});	
});

router.post('/telegramMessage', async (request, app) => {

	const {db} = app;
	const telegramProvidedToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
	const savedToken = await db.getSetting("telegram_security_code");
	
	if (telegramProvidedToken !== savedToken) {
		return new Response('Unauthorized', { status: 401 });
	}

	let messageJson = await request.json();
	await processMessage(messageJson, app);

	return new Response('Success', { status: 200 });
});

router.get('/updateTelegramMessages', async (request, app, env) => {
	if(!request.headers.get('Host').match(/^(localhost|127\.0\.0\.1)/)) {
		return new Response('This request is only supposed to be used locally', { status: 403 });
	}

	const {telegram, db} = app;
	let lastUpdateId = await db.getLatestUpdateId();
	let updates = await telegram.getUpdates(lastUpdateId);
	for (const update of updates.result) {
		await processMessage(update, app);
	}

	return new Response(`Success!
	Last update id: ${lastUpdateId}
	Updates: 
	${JSON.stringify(updates, null, 2)}`, { status: 200 });
});

router.post('/init', async (request, app, env) => {
	if(request.headers.get('Authorization') !== `Bearer ${env.INIT_SECRET}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	const {telegram, db} = app;

	let token = await db.getSetting("telegram_security_code");

	if (token === null) {
		token = crypto.getRandomValues(new Uint8Array(16)).join("");
		await db.initSetting("telegram_security_code", token);
	}

	let json = await request.json();
	let externalUrl = json.externalUrl;

	let response = await telegram.setWebhook(`${externalUrl}/telegramMessage`, token);

	return new Response('Success! ' + JSON.stringify(response), { status: 200 });
});

router.options('*', (request, app, env) => new Response('Success', {
	headers: {
		...app.corsHeaders
	},
	 status: 200 }));

router.all('*', () => new Response('404, not found!', { status: 404 }));

export default {
	fetch: handle,
};
