import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildFacts, composeDecision, legalMoves, normalizeState, simulateDecision } from './server.mjs'

// A "U" hugging the right wall: the tail occupies the only open cell below the
// head. Moving down into the vacating tail is legal Snake, and the server's
// legality must agree with the client (which allows it).
function wallHuggingState(food) {
	return normalizeState({
		grid: 16,
		snake: [
			{ x: 15, y: 5 },
			{ x: 15, y: 4 },
			{ x: 14, y: 4 },
			{ x: 14, y: 5 },
			{ x: 15, y: 6 },
		],
		direction: 'down',
		food,
	})
}

function answersFor(move, { confidence = 0.9, danger = 0, escape = 0.9 } = {}) {
	return {
		move: { type: 'choice', choice: move, probabilities: {}, confidence },
		strategy: { type: 'choice', choice: 'hunt_food' },
		position_danger: { type: 'score', score: danger },
		escape_route: { type: 'noul', noul: escape },
		aligned_with_food: { type: 'noul', noul: 0.5 },
	}
}

test('a move into the vacating tail cell is legal', () => {
	const state = wallHuggingState({ x: 0, y: 0 })
	assert.deepEqual(legalMoves(state), ['down'])
})

test('the tail does not vacate when the move eats', () => {
	const state = wallHuggingState({ x: 15, y: 6 })
	assert.deepEqual(legalMoves(state), [])
})

test('buildFacts marks the head and food on the board', () => {
	const facts = buildFacts(wallHuggingState({ x: 0, y: 0 }))
	const rows = facts.board.split('\n')
	assert.equal(rows[5][15], 'S')
	assert.equal(rows[0][0], 'F')
	assert.deepEqual(facts.legalMoves, ['down'])
})

test('an illegal Jev move triggers the code fallback', () => {
	const state = wallHuggingState({ x: 0, y: 0 })
	const decision = composeDecision(answersFor('up'), state, buildFacts(state))
	assert.equal(decision.gate, 'fallback')
	assert.equal(decision.usedFallback, true)
	assert.equal(decision.move, 'down')
})

test('low confidence triggers the review gate', () => {
	const state = wallHuggingState({ x: 0, y: 0 })
	const decision = composeDecision(answersFor('down', { confidence: 0.1 }), state, buildFacts(state))
	assert.equal(decision.gate, 'review')
	assert.equal(decision.usedFallback, true)
})

test("Jev's own no-escape signal triggers the review gate", () => {
	const state = wallHuggingState({ x: 0, y: 0 })
	const decision = composeDecision(answersFor('down', { escape: 0.1 }), state, buildFacts(state))
	assert.equal(decision.gate, 'review')
	assert.equal(decision.usedFallback, true)
})

test('a confident, legal move is acted on', () => {
	const state = wallHuggingState({ x: 0, y: 0 })
	const decision = composeDecision(answersFor('down'), state, buildFacts(state))
	assert.equal(decision.gate, 'act')
	assert.equal(decision.move, 'down')
	assert.equal(decision.usedFallback, false)
})

test('normalizeState clamps the grid, coordinates and direction', () => {
	const state = normalizeState({ grid: 100, snake: [{ x: 999, y: -5 }], direction: 'sideways' })
	assert.equal(state.grid, 32)
	assert.deepEqual(state.snake[0], { x: 31, y: 0 })
	assert.equal(state.direction, 'right')
})

test('normalizeState keeps known move sources and drops unknown ones', () => {
	assert.equal(normalizeState({ lastMoveSource: 'override' }).lastMoveSource, 'override')
	assert.equal(normalizeState({ lastMoveSource: 'human' }).lastMoveSource, 'human')
	assert.equal(normalizeState({ lastMoveSource: 'nonsense' }).lastMoveSource, null)
	assert.equal(normalizeState({}).lastMoveSource, null)
})

test('buildFacts carries the previous move source to the model', () => {
	const state = normalizeState({ ...wallHuggingState({ x: 0, y: 0 }), lastMoveSource: 'override' })
	assert.equal(buildFacts(state).lastMoveSource, 'override')
})

test('the simulated bot only picks legal moves', () => {
	const state = wallHuggingState({ x: 0, y: 0 })
	const simulation = simulateDecision(state, buildFacts(state))
	assert.ok(legalMoves(state).includes(simulation.move))
})
