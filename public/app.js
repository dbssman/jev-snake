const DIRS = {
	up: { x: 0, y: -1 },
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
}
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' }

const $ = (id) => document.getElementById(id)

const canvas = $('board')
const context = canvas.getContext('2d')
const sparkline = $('sparkline')
const sparkContext = sparkline.getContext('2d')

const GRID = 16

const game = {
	running: false,
	alive: true,
	driver: 'jev', // 'jev' | 'human'
	speedMs: 120,
	grid: GRID,
	snake: [],
	prevSnake: [],
	direction: 'right',
	food: { x: 0, y: 0 },
	score: 0,
	decisions: 0,
	fallbacks: 0,
	latencyHistory: [],
	decisionTimes: [],
	usage: { input_tokens: 0, output_tokens: 0 },
	lastDecision: null,
	lastPayload: null,
	lastLatencyMs: 0,
	requestInFlight: false,
	decisionAbort: null,
	loopToken: 0,
	pricePerMillionInputUsd: 0.042,
	anim: { active: false, start: 0, duration: 0, from: [], to: [] },
}

// ---------------------------------------------------------------------------
// Game setup
// ---------------------------------------------------------------------------

function resetGame() {
	game.loopToken += 1
	abortDecision()
	game.alive = true
	game.snake = []
	const startY = Math.floor(game.grid / 2)
	for (let i = 0; i < 4; i++) game.snake.push({ x: 4 - i, y: startY })
	game.prevSnake = game.snake.map((cell) => ({ ...cell }))
	game.direction = 'right'
	game.score = 0
	game.decisions = 0
	game.fallbacks = 0
	game.latencyHistory = []
	game.decisionTimes = []
	game.usage = { input_tokens: 0, output_tokens: 0 }
	game.lastDecision = null
	game.lastPayload = null
	game.anim = { active: false, start: 0, duration: 0, from: [], to: [] }
	placeFood()
	updateStats()
	hideOverlay()
	draw()
}

function placeFood() {
	const occupied = new Set(game.snake.map((cell) => `${cell.x},${cell.y}`))
	const free = []
	for (let y = 0; y < game.grid; y++) {
		for (let x = 0; x < game.grid; x++) {
			if (!occupied.has(`${x},${y}`)) free.push({ x, y })
		}
	}
	if (free.length === 0) {
		winGame()
		return
	}
	game.food = free[Math.floor(Math.random() * free.length)]
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

function legalMovesFrom(snake, direction, food) {
	const head = snake[0]
	// Same rule as the server: the tail is passable unless this move eats.
	const bodyWithTail = new Set(snake.map((cell) => `${cell.x},${cell.y}`))
	const bodyWithoutTail = new Set(bodyWithTail)
	const tail = snake[snake.length - 1]
	if (tail) bodyWithoutTail.delete(`${tail.x},${tail.y}`)

	const moves = []
	for (const [name, delta] of Object.entries(DIRS)) {
		if (name === OPPOSITE[direction]) continue
		const nextX = head.x + delta.x
		const nextY = head.y + delta.y
		if (nextX < 0 || nextY < 0 || nextX >= game.grid || nextY >= game.grid) continue
		const willEat = nextX === food.x && nextY === food.y
		const blocked = willEat ? bodyWithTail : bodyWithoutTail
		if (blocked.has(`${nextX},${nextY}`)) continue
		moves.push(name)
	}
	return moves
}

function applyMove(move) {
	if (!move || !DIRS[move]) return false
	const delta = DIRS[move]
	const head = game.snake[0]
	const next = { x: head.x + delta.x, y: head.y + delta.y }

	if (next.x < 0 || next.y < 0 || next.x >= game.grid || next.y >= game.grid) {
		endGame('Hit the wall')
		return false
	}
	const willEat = next.x === game.food.x && next.y === game.food.y
	const body = willEat ? game.snake : game.snake.slice(0, -1)
	if (body.some((cell) => cell.x === next.x && cell.y === next.y)) {
		endGame('Bit its own tail')
		return false
	}

	game.prevSnake = game.snake.map((cell) => ({ ...cell }))
	game.direction = move

	const grown = [next, ...game.snake]
	if (!willEat) grown.pop()
	game.snake = grown

	startAnimation()

	if (willEat) {
		game.score += 1
		placeFood()
	}
	return true
}

function startAnimation() {
	// The tick is latency-bound: pacing the glide to the observed call latency keeps
	// the motion continuous instead of stepping then freezing while we wait.
	const step = Math.max(game.speedMs, game.lastLatencyMs || 0)
	const duration = Math.min(Math.max(step, 60), 900)
	game.anim = { active: true, start: performance.now(), duration, from: game.prevSnake, to: game.snake }
}

function endGame(reason) {
	game.alive = false
	game.running = false
	game.loopToken += 1
	showOverlay('Game over', `${reason}. Score ${game.score} · ${game.decisions} decisions.`)
	updatePlayButton()
}

function winGame() {
	game.alive = false
	game.running = false
	game.loopToken += 1
	showOverlay('Board cleared', `Score ${game.score} · ${game.decisions} decisions.`)
	updatePlayButton()
}

// ---------------------------------------------------------------------------
// Decision loop
// ---------------------------------------------------------------------------

async function runLoop() {
	const token = ++game.loopToken
	while (game.running && token === game.loopToken) {
		const started = performance.now()
		if (game.driver === 'jev') {
			await decideAndApply(token)
		} else {
			if (!applyMove(game.direction)) break
		}
		if (!game.alive) break

		const elapsed = performance.now() - started
		const wait = Math.max(0, game.speedMs - elapsed)
		await sleep(wait)
	}
}

async function decideAndApply(token) {
	if (game.requestInFlight) return
	game.requestInFlight = true
	const controller = new AbortController()
	game.decisionAbort = controller
	// Must be the outer bound: the server retries up to 3 x 4s plus backoff before
	// it answers, so the client should not give up first.
	const timeoutId = setTimeout(() => controller.abort(), 20000)
	try {
		const response = await fetch('/api/decide', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ state: clientState() }),
			signal: controller.signal,
		})
		const data = await response.json()
		if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
		// A response that lands after a reset or a driver switch must be dropped.
		if (!game.running || token !== game.loopToken) return

		game.decisions += 1
		game.decisionTimes.push(performance.now())
		if (typeof data.latencyMs === 'number' && data.mode === 'jev' && data.latencyMs > 0) {
			game.latencyHistory.push(data.latencyMs)
			if (game.latencyHistory.length > 80) game.latencyHistory.shift()
			game.lastLatencyMs = data.latencyMs
		}
		if (data.usage) {
			game.usage.input_tokens += data.usage.input_tokens ?? 0
			game.usage.output_tokens += data.usage.output_tokens ?? 0
		}
		game.lastDecision = data
		game.lastPayload = data
		if (data.decision?.usedFallback) game.fallbacks += 1
		flashGate(data.decision?.gate)

		renderAnswers(data)
		drawSparkline()
		updateStats()

		if (data.decision?.move) applyMove(data.decision.move)
		else endGame('No legal move')
	} catch (error) {
		if (error.name === 'AbortError') return
		console.error(error)
		if (token !== game.loopToken) return
		const moves = legalMovesFrom(game.snake, game.direction, game.food)
		if (moves.length > 0) applyMove(moves[0])
		else endGame('No legal move')
	} finally {
		clearTimeout(timeoutId)
		if (game.decisionAbort === controller) {
			game.decisionAbort = null
			game.requestInFlight = false
		}
	}
}

function abortDecision() {
	if (!game.decisionAbort) return
	game.decisionAbort.abort()
	game.decisionAbort = null
	game.requestInFlight = false
}

function clientState() {
	return {
		grid: game.grid,
		snake: game.snake.map((cell) => ({ x: cell.x, y: cell.y })),
		direction: game.direction,
		food: { ...game.food },
		score: game.score,
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function resizeCanvas() {
	const rect = canvas.getBoundingClientRect()
	const devicePixelRatio = window.devicePixelRatio || 1
	canvas.width = Math.round(rect.width * devicePixelRatio)
	canvas.height = Math.round(rect.height * devicePixelRatio)
	context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)

	const sparkRect = sparkline.getBoundingClientRect()
	sparkline.width = Math.round(sparkRect.width * devicePixelRatio)
	sparkline.height = Math.round(sparkRect.height * devicePixelRatio)
	sparkContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
}

function cellSize() {
	const rect = canvas.getBoundingClientRect()
	return rect.width / game.grid
}

function interpolatedSnake() {
	if (!game.anim.active) return game.snake
	const t = Math.min(1, (performance.now() - game.anim.start) / game.anim.duration)
	const eased = t * t * (3 - 2 * t)
	const { from, to } = game.anim
	const result = to.map((cell, index) => {
		const source = from[Math.min(index, from.length - 1)] ?? cell
		return { x: source.x + (cell.x - source.x) * eased, y: source.y + (cell.y - source.y) * eased }
	})
	if (t >= 1) game.anim.active = false
	return result
}

function draw() {
	const size = cellSize()
	const width = size * game.grid
	context.clearRect(0, 0, canvas.width, canvas.height)

	// grid
	context.strokeStyle = '#0e1a2a'
	context.lineWidth = 1
	for (let i = 1; i < game.grid; i++) {
		context.beginPath()
		context.moveTo(i * size, 0)
		context.lineTo(i * size, width)
		context.stroke()
		context.beginPath()
		context.moveTo(0, i * size)
		context.lineTo(width, i * size)
		context.stroke()
	}

	// food
	context.fillStyle = '#ff6b6b'
	context.shadowColor = '#ff6b6b'
	context.shadowBlur = 16
	context.beginPath()
	context.arc((game.food.x + 0.5) * size, (game.food.y + 0.5) * size, size * 0.32, 0, Math.PI * 2)
	context.fill()
	context.shadowBlur = 0

	// Highlight the cell Jev chose, anchored to the head's pre-move cell and shown
	// only for the duration of the glide into it.
	const move = game.lastDecision?.decision?.move
	if (
		move &&
		game.anim.active &&
		game.running &&
		game.driver === 'jev' &&
		game.lastDecision?.decision?.gate !== 'review'
	) {
		const fromHead = game.anim.from[0]
		if (fromHead) {
			const delta = DIRS[move]
			const targetX = fromHead.x + delta.x
			const targetY = fromHead.y + delta.y
			if (targetX >= 0 && targetY >= 0 && targetX < game.grid && targetY < game.grid) {
				const tx = (targetX + 0.5) * size
				const ty = (targetY + 0.5) * size
				context.strokeStyle = 'rgba(56, 224, 176, 0.85)'
				context.lineWidth = 2.5
				context.setLineDash([5, 4])
				context.beginPath()
				context.arc(tx, ty, size * 0.4, 0, Math.PI * 2)
				context.stroke()
				context.setLineDash([])
			}
		}
	}

	// snake
	const snake = interpolatedSnake()
	for (let i = snake.length - 1; i >= 0; i--) {
		const cell = snake[i]
		const px = cell.x * size
		const py = cell.y * size
		const inset = Math.max(1.2, size * 0.09)
		const radius = size * 0.26
		if (i === 0) {
			context.fillStyle = '#7ff7d6'
			context.shadowColor = '#38e0b0'
			context.shadowBlur = 18
		} else {
			const shade = Math.max(0.45, 1 - i / (snake.length + 4))
			context.fillStyle = `rgba(56, 224, 176, ${shade})`
			context.shadowBlur = 0
		}
		roundRect(px + inset, py + inset, size - inset * 2, size - inset * 2, radius)
		context.fill()
	}
	context.shadowBlur = 0

	drawBoardLabel()
}

function drawBoardLabel() {
	const label = game.lastDecision?.mode === 'simulated' ? 'SIMULATED' : 'JEV'
	context.font = '600 11px ui-monospace, Menlo, monospace'
	context.fillStyle = 'rgba(139, 155, 180, 0.55)'
	context.fillText(`${label} · ${game.grid}×${game.grid}`, 10, 18)
}

function roundRect(x, y, w, h, r) {
	context.beginPath()
	context.moveTo(x + r, y)
	context.arcTo(x + w, y, x + w, y + h, r)
	context.arcTo(x + w, y + h, x, y + h, r)
	context.arcTo(x, y + h, x, y, r)
	context.arcTo(x, y, x + w, y, r)
	context.closePath()
}

function drawSparkline() {
	const rect = sparkline.getBoundingClientRect()
	const width = rect.width
	const height = rect.height
	sparkContext.clearRect(0, 0, width, height)
	const values = game.latencyHistory
	if (values.length === 0) return
	const max = Math.max(150, ...values)
	const step = values.length > 1 ? width / (values.length - 1) : width
	const points = values.map((value, index) => ({
		x: index * step,
		y: height - (value / max) * (height - 8) - 4,
	}))

	sparkContext.strokeStyle = '#38e0b0'
	sparkContext.lineWidth = 1.8
	sparkContext.beginPath()
	points.forEach((point, index) =>
		index === 0 ? sparkContext.moveTo(point.x, point.y) : sparkContext.lineTo(point.x, point.y),
	)
	sparkContext.stroke()

	const last = points[points.length - 1]
	sparkContext.fillStyle = '#7ff7d6'
	sparkContext.beginPath()
	sparkContext.arc(last.x, last.y, 2.6, 0, Math.PI * 2)
	sparkContext.fill()
}

function frame() {
	draw()
	requestAnimationFrame(frame)
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function average(values) {
	if (values.length === 0) return 0
	return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values, p) {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
	return sorted[index]
}

function updateStats() {
	$('stat-score').textContent = String(game.score)
	$('stat-decisions').textContent = String(game.decisions)

	const latencies = game.latencyHistory
	$('stat-latency').textContent = latencies.length ? `${Math.round(average(latencies))}ms` : '—'

	const now = performance.now()
	game.decisionTimes = game.decisionTimes.filter((time) => now - time < 4000)
	$('stat-rate').textContent = game.decisions > 0 ? (game.decisionTimes.length / 4).toFixed(1) : '—'

	$('latency-summary').textContent = latencies.length
		? `avg ${Math.round(average(latencies))}ms · p95 ${Math.round(percentile(latencies, 95))}ms`
		: 'no calls yet'

	const cost = (game.usage.input_tokens / 1_000_000) * game.pricePerMillionInputUsd
	$('cost-total').textContent = `$${cost.toFixed(6)}`
	$('cost-detail').textContent =
		`${game.usage.input_tokens.toLocaleString()} input tokens · ${game.fallbacks} fallbacks`
}

function barRow(label, value, chosen) {
	const percentage = Math.max(0, Math.min(1, value))
	return `<div class="bar">
		<span class="bar-label">${escapeHtml(label)}</span>
		<span class="bar-track"><span class="bar-fill ${chosen ? 'chosen' : ''}" style="width:${(percentage * 100).toFixed(1)}%"></span></span>
		<span class="bar-pct">${(percentage * 100).toFixed(0)}%</span>
	</div>`
}

function renderAnswers(data) {
	const container = $('answers')
	const answers = data.answers ?? {}
	const decision = data.decision ?? {}
	const parts = []

	const move = answers.move
	if (move) {
		const chosen = move.choice
		const ordered = Object.entries(move.probabilities ?? {}).sort((a, b) => b[1] - a[1])
		parts.push(`
			<div class="answer-row">
				<div class="answer-head">
					<span class="answer-key">move</span>
					<span class="answer-value">${escapeHtml(chosen ?? '—')} · conf ${Number(move.confidence ?? 0).toFixed(2)}</span>
				</div>
				<div class="bars">${ordered.map(([option, probability]) => barRow(option, probability, option === chosen)).join('')}</div>
			</div>`)
	}

	if (answers.strategy) {
		parts.push(`
			<div class="answer-row">
				<div class="answer-head"><span class="answer-key">strategy</span>
				<span class="answer-value">${escapeHtml(answers.strategy.choice ?? '—')}</span></div>
			</div>`)
	}

	if (answers.position_danger) {
		parts.push(`
			<div class="answer-row">
				<div class="answer-head"><span class="answer-key">position danger</span>
				<span class="answer-value">${Number(answers.position_danger.score ?? 0).toFixed(2)} / 2</span></div>
			</div>`)
	}

	if (answers.escape_route) {
		parts.push(`
			<div class="answer-row">
				<div class="answer-head"><span class="answer-key">escape route</span>
				<span class="answer-value">P(${Number(answers.escape_route.noul ?? 0).toFixed(2)})</span></div>
			</div>`)
	}

	if (data.decision?.reason && data.decision.gate !== 'act') {
		parts.push(`<div class="reason">${escapeHtml(data.decision.reason)}</div>`)
	}

	container.innerHTML = parts.length ? parts.join('') : '<p class="muted">Waiting for answers…</p>'

	const inspect = $('inspect')
	if (!inspect.classList.contains('hidden')) {
		inspect.textContent = JSON.stringify(
			{
				mode: data.mode,
				model: data.model,
				latencyMs: data.latencyMs,
				usage: data.usage,
				request: data.request,
				answers: data.answers,
				decision: data.decision,
			},
			null,
			2,
		)
	}
}

function flashGate(gate) {
	const badge = $('gate-badge')
	badge.className = 'badge'
	if (gate === 'act') {
		badge.classList.add('badge-act')
		badge.textContent = 'code gate: act'
	} else if (gate === 'review') {
		badge.classList.add('badge-review')
		badge.textContent = 'code gate: review → fallback'
	} else if (gate === 'fallback' || gate === 'dead_end') {
		badge.classList.add('badge-fallback')
		badge.textContent = 'code gate: fallback'
	} else {
		badge.classList.add('badge-muted')
		badge.textContent = 'idle'
	}
}

function escapeHtml(value) {
	return String(value).replace(
		/[&<>"']/g,
		(character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
	)
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function showOverlay(title, text) {
	$('overlay-title').textContent = title
	$('overlay-text').textContent = text
	$('overlay').classList.remove('hidden')
}

function hideOverlay() {
	$('overlay').classList.add('hidden')
}

function updatePlayButton() {
	$('play').textContent = game.running ? '❚❚ Pause' : '▶ Play'
}

function togglePlay() {
	if (!game.alive) resetGame()
	game.running = !game.running
	updatePlayButton()
	if (game.running) {
		hideOverlay()
		runLoop()
	} else {
		game.loopToken += 1
		abortDecision()
		showOverlay('Paused', 'Press play to continue.')
	}
}

function setDriver(driver) {
	game.driver = driver
	$('driver-jev').classList.toggle('active', driver === 'jev')
	$('driver-human').classList.toggle('active', driver === 'human')
	hideOverlay()
	if (game.running) {
		game.loopToken += 1
		abortDecision()
		runLoop()
	}
}

function bindControls() {
	$('play').addEventListener('click', togglePlay)
	$('reset').addEventListener('click', () => {
		const wasRunning = game.running
		resetGame()
		updatePlayButton()
		if (wasRunning && game.alive) runLoop()
	})
	$('driver-jev').addEventListener('click', () => setDriver('jev'))
	$('driver-human').addEventListener('click', () => setDriver('human'))
	$('speed').addEventListener('input', (event) => {
		game.speedMs = Number(event.target.value)
		$('speed-value').textContent = `${game.speedMs}ms`
	})
	$('inspect-toggle').addEventListener('click', () => {
		const inspect = $('inspect')
		const hidden = inspect.classList.toggle('hidden')
		$('inspect-toggle').textContent = hidden ? 'Show request + answer' : 'Hide request + answer'
		if (!hidden && game.lastPayload) renderAnswers(game.lastPayload)
	})

	window.addEventListener('keydown', (event) => {
		const map = {
			ArrowUp: 'up',
			ArrowDown: 'down',
			ArrowLeft: 'left',
			ArrowRight: 'right',
			w: 'up',
			s: 'down',
			a: 'left',
			d: 'right',
			W: 'up',
			S: 'down',
			A: 'left',
			D: 'right',
		}
		const move = map[event.key]
		if (!move) return
		event.preventDefault()
		if (game.driver !== 'human' || !game.alive) return
		if (move === OPPOSITE[game.direction]) return
		if (!game.running) {
			// Queue the intended direction for the loop's first iteration instead of
			// moving here, which would apply a second move on top of the loop's own.
			game.running = true
			game.direction = move
			updatePlayButton()
			hideOverlay()
			runLoop()
			return
		}
		// Running: only steer; the loop advances on its own tick so pacing stays even.
		game.direction = move
	})

	window.addEventListener('resize', () => {
		resizeCanvas()
		drawSparkline()
	})
}

async function loadHealth() {
	try {
		const response = await fetch('/api/health')
		const health = await response.json()
		const badge = $('mode-badge')
		if (health.mode === 'jev') {
			badge.className = 'badge badge-live'
			badge.textContent = 'JEV LIVE'
		} else {
			badge.className = 'badge badge-sim'
			badge.textContent = 'SIMULATED (no key)'
		}
		$('model-badge').className = 'badge badge-muted'
		$('model-badge').textContent = health.model
		if (typeof health.pricePerMillionInputUsd === 'number') {
			game.pricePerMillionInputUsd = health.pricePerMillionInputUsd
			$('price-label').textContent = `$${health.pricePerMillionInputUsd} / 1M input tokens, output free`
		}
	} catch {
		$('mode-badge').textContent = 'server offline'
	}
}

function init() {
	resizeCanvas()
	bindControls()
	resetGame()
	loadHealth()
	frame()
}

init()
