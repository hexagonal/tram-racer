# Tram Racer

A silly 8-bit tram race that runs in a web browser. You and a CPU driver start on the pavement, sprint to your trams, jump in, and race down two parallel tracks to the end of the line.

## How to play

1. Press **Enter** (or click the game) to start.
2. After the countdown, **run to your tram** by tapping **←** and **→** one after the other, as fast as you can.
3. Once you're aboard, the tram can only go forwards on its track:
   - **→** (or **D**) powers the tram.
   - **←** (or **A**) brakes.
4. Watch out for:
   - **Slow zones** (yellow and black strip, "40" sign): go over 40 km/h in one and you derail.
   - **Road crossings**: when the light by your track is red, a car is about to cross. Stop, or hit it.
5. First tram past the chequered flag wins. Press **Enter** to race again.

## Running it

There is no build step. Open `index.html` in a browser, or serve the folder with any static server, for example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

All paths are relative, so it also works from GitHub Pages under a subpath.

## Files

- `index.html`: the page and canvas.
- `game.js`: the whole game (plain JavaScript, HTML5 canvas, Web Audio for the bleeps).
