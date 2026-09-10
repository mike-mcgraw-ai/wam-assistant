/**
 * Pong, for a 576x288 monochrome text grid.
 *
 * Everything here is pure: `tick`, `nudge` and `serve` take a state and return
 * a state, and `renderPong` turns one into a string. No bridge, no timers, no
 * DOM — which means the whole game is testable from a script on a laptop, and
 * the only thing the glasses layer has to do is call it on an interval.
 *
 * The hard constraint is input. The touchpad emits discrete scroll events, not
 * a held direction, so the paddle moves a fixed number of rows per flick
 * rather than tracking your thumb. Ball speed is tuned around that: fast
 * enough to be a game, slow enough that a flick can still reach the ball.
 */

export const COLS = 40
export const ROWS = 7
export const PADDLE = 2
/** Rows the paddle jumps per scroll event. */
export const NUDGE = 1
export const WIN_SCORE = 5

export interface PongState {
  ballX: number
  ballY: number
  vx: number
  vy: number
  playerY: number
  cpuY: number
  playerScore: number
  cpuScore: number
  /** 'serve' waits for a click; 'play' is live; 'over' is a finished match */
  phase: 'serve' | 'play' | 'over'
  /** who serves next; also which way the ball launches */
  servingTo: 1 | -1
  ticks: number
}

export function newGame(): PongState {
  return {
    ballX: COLS / 2,
    ballY: ROWS / 2,
    vx: 0,
    vy: 0,
    playerY: Math.floor((ROWS - PADDLE) / 2),
    cpuY: Math.floor((ROWS - PADDLE) / 2),
    playerScore: 0,
    cpuScore: 0,
    phase: 'serve',
    servingTo: 1,
    ticks: 0,
  }
}

export function serve(state: PongState): PongState {
  if (state.phase === 'over') return newGame()
  if (state.phase !== 'serve') return state
  return {
    ...state,
    phase: 'play',
    ballX: COLS / 2,
    ballY: ROWS / 2,
    vx: 1.1 * state.servingTo,
    // A little vertical kick so the opening rally is not a straight line.
    vy: (state.ticks % 2 === 0 ? 0.35 : -0.35),
  }
}

export function nudge(state: PongState, delta: number): PongState {
  const playerY = Math.max(0, Math.min(ROWS - PADDLE, state.playerY + delta * NUDGE))
  return { ...state, playerY }
}

/** Where the paddle's centre sits, for collision and for the CPU's aim. */
const centre = (y: number) => y + PADDLE / 2

export function tick(state: PongState): PongState {
  if (state.phase !== 'play') return { ...state, ticks: state.ticks + 1 }

  let { ballX, ballY, vx, vy, cpuY, playerScore, cpuScore } = state

  ballX += vx
  ballY += vy

  // Top and bottom walls.
  if (ballY < 0) {
    ballY = -ballY
    vy = -vy
  } else if (ballY > ROWS - 1) {
    ballY = 2 * (ROWS - 1) - ballY
    vy = -vy
  }

  // Player paddle on the left.
  if (ballX <= 1 && vx < 0) {
    if (ballY >= state.playerY - 0.5 && ballY <= state.playerY + PADDLE - 0.5) {
      ballX = 1
      vx = -vx
      // Hit off-centre and the ball leaves at an angle — the only real skill
      // available given the paddle can barely be aimed.
      vy += (ballY - centre(state.playerY)) * 0.45
      vy = Math.max(-1.1, Math.min(1.1, vy))
    } else {
      return {
        ...state,
        cpuScore: cpuScore + 1,
        phase: cpuScore + 1 >= WIN_SCORE ? 'over' : 'serve',
        servingTo: 1,
        ballX: COLS / 2,
        ballY: ROWS / 2,
        vx: 0,
        vy: 0,
        ticks: state.ticks + 1,
      }
    }
  }

  // CPU paddle on the right.
  if (ballX >= COLS - 2 && vx > 0) {
    if (ballY >= cpuY - 0.5 && ballY <= cpuY + PADDLE - 0.5) {
      ballX = COLS - 2
      vx = -vx
      vy += (ballY - centre(cpuY)) * 0.45
      vy = Math.max(-1.1, Math.min(1.1, vy))
    } else {
      return {
        ...state,
        playerScore: playerScore + 1,
        phase: playerScore + 1 >= WIN_SCORE ? 'over' : 'serve',
        servingTo: -1,
        ballX: COLS / 2,
        ballY: ROWS / 2,
        vx: 0,
        vy: 0,
        ticks: state.ticks + 1,
      }
    }
  }

  // CPU tracks the ball but only closes part of the gap each tick, and only
  // while the ball is coming toward it. Perfect tracking would be unbeatable,
  // and unbeatable is not a game.
  if (vx > 0) {
    const drift = ballY - centre(cpuY)
    if (Math.abs(drift) > 0.4) cpuY += Math.sign(drift) * 0.55
    cpuY = Math.max(0, Math.min(ROWS - PADDLE, cpuY))
  }

  return { ...state, ballX, ballY, vx, vy, cpuY, ticks: state.ticks + 1 }
}

/** The playfield plus a scoreline, sized to fit the text container. */
export function renderPong(state: PongState): string {
  const bx = Math.round(state.ballX)
  const by = Math.round(state.ballY)
  const cpuTop = Math.round(state.cpuY)

  const lines: string[] = []
  lines.push(
    `PONG   you ${state.playerScore}  cpu ${state.cpuScore}   first to ${WIN_SCORE}`,
  )
  lines.push('+' + '-'.repeat(COLS) + '+')

  for (let row = 0; row < ROWS; row += 1) {
    const cells = new Array(COLS).fill(' ')

    // Centre line, dotted so it does not read as a wall.
    if (row % 2 === 0) cells[Math.floor(COLS / 2)] = ':'

    if (row >= state.playerY && row < state.playerY + PADDLE) cells[0] = '|'
    if (row >= cpuTop && row < cpuTop + PADDLE) cells[COLS - 1] = '|'

    if (row === by && bx >= 0 && bx < COLS) cells[bx] = 'o'

    lines.push('|' + cells.join('') + '|')
  }

  lines.push('+' + '-'.repeat(COLS) + '+')

  if (state.phase === 'serve') {
    lines.push(state.ticks === 0 ? 'click to serve   dbl exit' : 'click to serve')
  } else if (state.phase === 'over') {
    lines.push(
      state.playerScore > state.cpuScore ? 'YOU WIN   click again' : 'CPU WINS   click again',
    )
  } else {
    lines.push('scroll to move   dbl exit')
  }

  return lines.join('\n')
}
