#!/usr/bin/env node
/**
 * Jev Snake — zero-dependency demo server.
 *
 * Responsibilities:
 *  - Serve the static game (public/) and keep the TypeSafe API key server-side.
 *  - Build a text "board" state + typed questions (Choice / Score / Noul) for Jev.
 *  - Call POST https://api.typesafe.ai/v1/systemone and return typed answers.
 *  - Compose the final move in CODE (legality + confidence + safety gates),
 *    never in the model.
 *
 * If no TYPESAFE_API_KEY is set, the server falls back to a deterministic
 * local bot so the demo still runs. The UI clearly labels that mode.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')

const DIRS = {
	up: { x: 0, y: -1 },
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
}
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' }
const DIR_NAMES = Object.keys(DIRS)

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function parseEnv(contents) {
	const out = {}
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const equalsIndex = line.indexOf('=')
		if (equalsIndex === -1) continue
		const key = line.slice(0, equalsIndex).trim()
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
		let value = line.slice(equalsIndex + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		} else {
			const hash = value.indexOf(' #')
			if (hash !== -1) value = value.slice(0, hash).trim()
		}
		if (value) out[key] = value
	}
	return out
}

// Only the keys this demo actually consumes are read out of the .env files, so
// the repository-root .env (which holds unrelated secrets) is never injected
// wholesale into this process.
const CONSUMED_ENV_KEYS = [
	'TYPESAFE_API_KEY',
	'TYPESAFE_MODEL',
	'TYPESAFE_API_URL',
	'TYPESAFE_TIMEOUT_MS',
	'PORT',
	'JEV_DEMO_PORT',
	'HOST',
]

function loadEnvironment() {
	const fileEnv = {}
	// Most specific file first; an earlier file wins over a later one.
	for (const file of [path.join(__dirname, '.env'), path.resolve(__dirname, '../../.env')]) {
		try {
			const parsed = parseEnv(readFileSync(file, 'utf8'))
			for (const [name, value] of Object.entries(parsed)) {
				if (!(name in fileEnv)) fileEnv[name] = value
			}
		} catch {
			/* file not present */
		}
	}
	// A value already present in the real process environment always wins.
	for (const name of CONSUMED_ENV_KEYS) {
		if (!process.env[name] && fileEnv[name]) process.env[name] = fileEnv[name]
	}
	return { apiKey: process.env.TYPESAFE_API_KEY || '' }
}

// Loaded before the config constants below so that .env values are visible to them.
const ENV = loadEnvironment()

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? process.env.JEV_DEMO_PORT ?? 4321)
const MODEL = process.env.TYPESAFE_MODEL ?? 'jev-latest'
const API_URL = process.env.TYPESAFE_API_URL ?? 'https://api.typesafe.ai/v1/systemone'
const PRICE_PER_MILLION_INPUT_USD = 0.042
const REQUEST_TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS ?? 4000)

// ---------------------------------------------------------------------------
// Board + facts (all arithmetic/spatial bookkeeping happens here, in code)
// ---------------------------------------------------------------------------

function key(x, y) {
	return `${x},${y}`
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value))
}

function normalizeState(input) {
	const grid = clamp(Number(input?.grid) || 16, 8, 32)
	const snake = Array.isArray(input?.snake)
		? input.snake.slice(0, grid * grid).map((cell) => ({
				x: clamp(Number(cell?.x) | 0, 0, grid - 1),
				y: clamp(Number(cell?.y) | 0, 0, grid - 1),
			}))
		: []
	if (snake.length === 0) snake.push({ x: 1, y: 1 }, { x: 0, y: 1 })

	const head = snake[0]
	const food = {
		x: clamp(Number(input?.food?.x) | 0, 0, grid - 1),
		y: clamp(Number(input?.food?.y) | 0, 0, grid - 1),
	}

	const requested = String(input?.direction ?? 'right')
	const direction = DIR_NAMES.includes(requested) ? requested : 'right'

	return { grid, snake, head, food, direction }
}

function bodySet(snake, { includeTail = true } = {}) {
	const set = new Set()
	const limit = includeTail ? snake.length : snake.length - 1
	for (let i = 0; i < limit; i++) set.add(key(snake[i].x, snake[i].y))
	return set
}

function inBounds(x, y, grid) {
	return x >= 0 && y >= 0 && x < grid && y < grid
}

function legalMoves(state) {
	const { head, grid, snake, direction, food } = state
	// A move into the cell the tail is vacating is legal, so legality is decided
	// per candidate destination: the tail counts as blocked only when this move
	// does not eat (i.e. the tail actually moves away).
	const bodyWithTail = bodySet(snake, { includeTail: true })
	const bodyWithoutTail = new Set(bodyWithTail)
	const tail = snake[snake.length - 1]
	if (tail) bodyWithoutTail.delete(key(tail.x, tail.y))

	const moves = []
	for (const name of DIR_NAMES) {
		if (name === OPPOSITE[direction]) continue
		const { x, y } = DIRS[name]
		const nx = head.x + x
		const ny = head.y + y
		if (!inBounds(nx, ny, grid)) continue
		const willEat = nx === food.x && ny === food.y
		const blocked = willEat ? bodyWithTail : bodyWithoutTail
		if (!blocked.has(key(nx, ny))) moves.push(name)
	}
	return moves
}

function distanceToFood(from, food) {
	return Math.abs(from.x - food.x) + Math.abs(from.y - food.y)
}

/** Flood fill of open cells reachable from (x,y), treating snake body as walls. */
function reachableSpace(x, y, state, { ignoreTail = true } = {}) {
	const { grid, snake } = state
	const blocked = bodySet(snake, { includeTail: !ignoreTail })
	if (!inBounds(x, y, grid) || blocked.has(key(x, y))) return 0
	const seen = new Set([key(x, y)])
	const queue = [[x, y]]
	let count = 0
	while (queue.length > 0) {
		const [cx, cy] = queue.shift()
		count += 1
		for (const name of DIR_NAMES) {
			const nx = cx + DIRS[name].x
			const ny = cy + DIRS[name].y
			const cell = key(nx, ny)
			if (!inBounds(nx, ny, grid) || blocked.has(cell) || seen.has(cell)) continue
			seen.add(cell)
			queue.push([nx, ny])
		}
	}
	return count
}

function boardString(state) {
	const { grid, snake, head, food } = state
	const body = bodySet(snake, { includeTail: true })
	const rows = []
	for (let y = 0; y < grid; y++) {
		let row = ''
		for (let x = 0; x < grid; x++) {
			if (x === head.x && y === head.y) row += 'S'
			else if (x === food.x && y === food.y) row += 'F'
			else if (body.has(key(x, y))) row += '#'
			else row += '.'
		}
		rows.push(row)
	}
	return rows.join('\n')
}

function buildFacts(state) {
	const { grid, snake, head, food } = state
	const moves = legalMoves(state)
	const distanceToFoodByMove = {}
	for (const name of moves) {
		const nx = head.x + DIRS[name].x
		const ny = head.y + DIRS[name].y
		distanceToFoodByMove[name] = distanceToFood({ x: nx, y: ny }, food)
	}
	return {
		board: boardString(state),
		grid,
		snakeLength: snake.length,
		head: { x: head.x, y: head.y },
		direction: state.direction,
		food: { x: food.x, y: food.y },
		legalMoves: moves,
		distanceToFoodByMove,
		distanceToFoodNow: distanceToFood(head, food),
		openSpaceFromHead: reachableSpace(head.x, head.y, state),
		freeCells: grid * grid - snake.length,
	}
}

// ---------------------------------------------------------------------------
// Code-composed move policy (fallback + safety gate)
// ---------------------------------------------------------------------------

function scoreMoves(state, moves) {
	const { head, food } = state
	const scored = []
	for (const name of moves) {
		const nx = head.x + DIRS[name].x
		const ny = head.y + DIRS[name].y
		const space = reachableSpace(nx, ny, state)
		const distance = distanceToFood({ x: nx, y: ny }, food)
		if (space === 0) {
			scored.push({ move: name, score: -1000, space, distance })
			continue
		}
		scored.push({ move: name, score: space * 2 - distance * 3, space, distance })
	}
	return scored.sort((a, b) => b.score - a.score || a.distance - b.distance)
}

function safeFallback(state, moves) {
	if (moves.length === 0) return null
	return scoreMoves(state, moves)[0].move
}

function softmax(scored) {
	const max = Math.max(...scored.map((entry) => entry.score))
	const exponentials = scored.map((entry) => Math.exp((entry.score - max) / 6))
	const total = exponentials.reduce((sum, value) => sum + value, 0) || 1
	return scored.map((entry, index) => ({ ...entry, probability: exponentials[index] / total }))
}

function simulateDecision(state, facts) {
	const scored = scoreMoves(state, facts.legalMoves)
	if (scored.length === 0) {
		return { move: null, probabilities: {}, confidence: 0, strategy: 'trapped', danger: 2, escape: 0 }
	}
	const withProbabilities = softmax(scored)
	const best = withProbabilities[0]
	const probabilities = Object.fromEntries(withProbabilities.map((entry) => [entry.move, entry.probability]))
	const openRatio = facts.openSpaceFromHead / Math.max(1, facts.freeCells)
	const danger = openRatio < 0.25 ? 2 : openRatio < 0.55 ? 1 : 0
	return {
		move: best.move,
		probabilities,
		confidence: Number((best.probability ?? 0).toFixed(3)),
		strategy:
			danger === 2 ? 'escape_trap' : best.distance <= facts.distanceToFoodNow ? 'hunt_food' : 'maintain_space',
		danger,
		escape: facts.legalMoves.length > 1 ? 0.9 : 0.4,
	}
}

// ---------------------------------------------------------------------------
// Typed questions for Jev
// ---------------------------------------------------------------------------

function buildQuestions(facts) {
	const moveCriteria = {}
	for (const name of facts.legalMoves) {
		const after = facts.distanceToFoodByMove[name]
		const relation =
			after < facts.distanceToFoodNow
				? 'moves closer to the food'
				: after > facts.distanceToFoodNow
					? 'moves further from the food'
					: 'keeps the same distance to the food'
		moveCriteria[name] = {
			move: `${name} (one cell ${name})`,
			distance_to_food_after_move: after,
			effect: `From the head it ${relation}.`,
		}
	}

	return {
		move: {
			type: 'choice',
			instructions: {
				question: 'Which single move should the snake head `S` take next? Choose only from `legalMoves`.',
				goal: 'Eat `F` and stay alive as long as possible. Never move into a wall or into the snake body `#`.',
				board: facts.board,
				legend: 'In `board`: # = snake body, S = snake head, F = food, . = empty cell. Rows are y (top to bottom), columns are x (left to right).',
				facts: {
					grid: facts.grid,
					head: facts.head,
					direction: facts.direction,
					food: facts.food,
					snakeLength: facts.snakeLength,
					legalMoves: facts.legalMoves,
					distanceToFoodNow: facts.distanceToFoodNow,
				},
			},
			criteria: moveCriteria,
		},
		strategy: {
			type: 'choice',
			instructions: "What is the snake's best strategy in the current `board`?",
			criteria: {
				hunt_food: 'Food `F` can be reached safely; head toward it now.',
				maintain_space: 'There is room to maneuver; prefer moves that keep open space.',
				escape_trap: 'The head `S` is boxed in; the priority is to escape without dying.',
				reposition: 'No immediate gain; circle to reposition the body and open a lane.',
			},
		},
		position_danger: {
			type: 'score',
			instructions: "How dangerous is the snake's current position in `board`?",
			criteria: [
				'Safe: plenty of open space and at least one clear escape route.',
				'Caution: space is limited or the body crowds the head, but options remain.',
				'Critical: the head is nearly boxed in with few or no safe moves.',
			],
		},
		escape_route: {
			type: 'noul',
			instructions:
				'Does the snake have at least one legal move that keeps a path to open space rather than sealing itself in?',
			criteria: {
				true: 'At least one move leads to an area with room to keep moving.',
				false: 'Every legal move leads into a tight dead end.',
			},
		},
		aligned_with_food: {
			type: 'noul',
			instructions:
				'Is the food `F` reachable from the head `S` in a straight horizontal or vertical line without crossing the snake body `#`?',
		},
	}
}

// ---------------------------------------------------------------------------
// TypeSafe API client
// ---------------------------------------------------------------------------

async function callJev(apiKey, state, questions) {
	const body = { model: MODEL, state, questions }
	let lastError
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await sleep(150 * 3 ** (attempt - 1))
		const started = performance.now()
		try {
			const response = await fetch(API_URL, {
				method: 'POST',
				headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			})
			const latencyMs = Math.round(performance.now() - started)
			if (response.status === 429 || response.status === 529 || response.status >= 500) {
				lastError = new Error(`TypeSafe ${response.status}`)
				continue
			}
			const payload = await response.json().catch(() => ({}))
			if (!response.ok) {
				const detail = payload?.error?.message ?? payload?.message ?? JSON.stringify(payload).slice(0, 300)
				throw Object.assign(new Error(`TypeSafe ${response.status}: ${detail}`), { fatal: true })
			}
			return { payload, latencyMs }
		} catch (error) {
			if (error?.fatal) throw error
			lastError = error
		}
	}
	throw lastError ?? new Error('TypeSafe request failed')
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Compose: Jev proposes, code decides
// ---------------------------------------------------------------------------

function composeDecision(answers, state, facts) {
	const legal = facts.legalMoves
	const fallback = safeFallback(state, legal)

	if (legal.length === 0) {
		return { move: null, gate: 'dead_end', reason: 'No legal move available.', usedFallback: false }
	}

	const jevMove = answers?.move?.choice ?? null
	// Defaults are permissive on purpose: if an answer field is missing or renamed,
	// "the code cannot judge" must not be mistaken for "the model is unsure", which
	// would force every decision through the fallback. Legality still guards.
	const confidence = Number(answers?.move?.confidence ?? 1)
	const danger = Number(answers?.position_danger?.score ?? 0)
	const escape = Number(answers?.escape_route?.noul ?? 1)

	const trace = {
		jevMove,
		jevConfidence: confidence,
		strategy: answers?.strategy?.choice ?? null,
		dangerScore: Number(danger.toFixed(2)),
		escapeProbability: Number(escape.toFixed(2)),
		foodAligned: Number(answers?.aligned_with_food?.noul ?? 0),
	}

	if (!legal.includes(jevMove)) {
		return {
			move: fallback,
			gate: 'fallback',
			reason: `Jev returned "${jevMove}", which is not a legal move. Code took the safe fallback.`,
			usedFallback: true,
			trace,
		}
	}

	if (confidence < 0.3) {
		return {
			move: fallback,
			gate: 'review',
			reason: `Low confidence (${confidence.toFixed(2)}). Code took over with the safe fallback.`,
			usedFallback: true,
			trace,
		}
	}

	if (escape < 0.2) {
		return {
			move: fallback,
			gate: 'review',
			reason: `Jev judged there is almost no escape route (P=${escape.toFixed(2)}). Code took the safe fallback.`,
			usedFallback: true,
			trace,
		}
	}

	return { move: jevMove, gate: 'act', reason: 'Jev choice accepted by the code gate.', usedFallback: false, trace }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
}

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload)
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Length': Buffer.byteLength(body),
	})
	response.end(body)
}

async function readBody(request) {
	const chunks = []
	let size = 0
	for await (const chunk of request) {
		size += chunk.length
		if (size > 1_000_000) throw new Error('Payload too large')
		chunks.push(chunk)
	}
	if (chunks.length === 0) return {}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw new Error('Invalid JSON body')
	}
}

async function serveStatic(response, pathname) {
	const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
	const resolved = path.resolve(PUBLIC_DIR, relative)
	const insidePublic = path.relative(PUBLIC_DIR, resolved)
	if (insidePublic.startsWith('..') || path.isAbsolute(insidePublic)) {
		response.writeHead(403).end('Forbidden')
		return
	}
	try {
		const file = await readFile(resolved)
		response.writeHead(200, {
			'Content-Type': CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream',
			'Cache-Control': 'no-store',
		})
		response.end(file)
	} catch {
		response.writeHead(404).end('Not found')
	}
}

async function handleDecide(request, response) {
	const body = await readBody(request)
	const state = normalizeState(body?.state)
	const facts = buildFacts(state)

	if (!ENV.apiKey) {
		const simulated = simulateDecision(state, facts)
		const answers = {
			move: {
				type: 'choice',
				choice: simulated.move,
				probabilities: simulated.probabilities,
				confidence: simulated.confidence,
			},
			strategy: { type: 'choice', choice: simulated.strategy, probabilities: {}, confidence: 1 },
			position_danger: {
				type: 'score',
				score: simulated.danger,
				legend: {
					0: 'Safe: plenty of open space and at least one clear escape route.',
					1: 'Caution: space is limited or the body crowds the head, but options remain.',
					2: 'Critical: the head is nearly boxed in with few or no safe moves.',
				},
				probabilities: {},
				confidence: 1,
			},
			escape_route: { type: 'noul', noul: simulated.escape },
		}
		const decision = composeDecision(answers, state, facts)
		sendJson(response, 200, {
			mode: 'simulated',
			model: 'local-heuristic',
			latencyMs: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			answers,
			decision,
			facts,
			request: { model: 'local-heuristic', state, questions: {} },
			note: 'TYPESAFE_API_KEY is not set — running the deterministic local bot. Set the key and reload to let Jev play.',
		})
		return
	}

	const questions = buildQuestions(facts)
	const requestState = {
		board: facts.board,
		legend: 'In `board`: # = snake body, S = snake head, F = food, . = empty cell.',
		grid: facts.grid,
		head: facts.head,
		direction: facts.direction,
		food: facts.food,
		snakeLength: facts.snakeLength,
		legalMoves: facts.legalMoves,
		distanceToFoodNow: facts.distanceToFoodNow,
		openSpaceFromHead: facts.openSpaceFromHead,
	}

	try {
		const { payload, latencyMs } = await callJev(ENV.apiKey, requestState, questions)
		const answers = payload?.answers ?? {}
		const decision = composeDecision(answers, state, facts)
		sendJson(response, 200, {
			mode: 'jev',
			model: payload?.model ?? MODEL,
			latencyMs,
			usage: payload?.usage ?? { input_tokens: 0, output_tokens: 0 },
			answers,
			decision,
			facts,
			request: { model: MODEL, state: requestState, questions },
		})
	} catch (error) {
		const fallbackDecision = {
			move: safeFallback(state, facts.legalMoves),
			gate: 'fallback',
			reason: `Jev call failed (${error.message}). Code took the safe fallback.`,
			usedFallback: true,
			trace: {},
		}
		sendJson(response, 200, {
			mode: 'jev',
			model: MODEL,
			latencyMs: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			answers: {},
			decision: fallbackDecision,
			facts,
			request: { model: MODEL, state: requestState, questions },
			error: error.message,
		})
	}
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
	try {
		if (request.method === 'GET' && url.pathname === '/api/health') {
			sendJson(response, 200, {
				mode: ENV.apiKey ? 'jev' : 'simulated',
				model: ENV.apiKey ? MODEL : 'local-heuristic',
				hasKey: Boolean(ENV.apiKey),
				pricePerMillionInputUsd: PRICE_PER_MILLION_INPUT_USD,
			})
			return
		}
		if (request.method === 'POST' && url.pathname === '/api/decide') {
			await handleDecide(request, response)
			return
		}
		if (request.method === 'GET') {
			await serveStatic(response, url.pathname)
			return
		}
		response.writeHead(405).end('Method not allowed')
	} catch (error) {
		sendJson(response, 400, { error: error.message })
	}
})

const isEntryPoint = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false

if (isEntryPoint) {
	server.listen(PORT, HOST, () => {
		const banner = ENV.apiKey
			? `Jev Snake — model ${MODEL} (TypeSafe API key detected)`
			: 'Jev Snake — SIMULATED mode (no TYPESAFE_API_KEY; add it to .env to let Jev play)'
		console.log(`\n  ${banner}`)
		console.log(`  -> http://${HOST}:${PORT}\n`)
	})
}

export { normalizeState, buildFacts, legalMoves, composeDecision, simulateDecision, scoreMoves, ENV }
