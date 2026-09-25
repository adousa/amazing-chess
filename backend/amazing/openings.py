"""A small ECO lookup (longest matching SAN prefix). Good enough to name the opening and to
mark the first moves of well-known lines as `book` in the analysis."""
from __future__ import annotations

from typing import List, Optional, Tuple

import chess

_LINES = """
A00 Irregular Opening|
A00 Polish Opening|b4
A00 Grob Opening|g4
A01 Nimzo-Larsen Attack|b3
A02 Bird's Opening|f4
A04 Reti Opening|Nf3
A05 Reti Opening|Nf3 Nf6
A06 Reti Opening|Nf3 d5
A09 Reti Opening|Nf3 d5 c4
A10 English Opening|c4
A20 English Opening|c4 e5
A30 English Opening: Symmetrical|c4 c5
A40 Queen's Pawn Game|d4
A41 Queen's Pawn Game|d4 d6
A43 Old Benoni Defense|d4 c5
A45 Indian Game|d4 Nf6
A46 Indian Game|d4 Nf6 Nf3
A48 London System|d4 Nf6 Nf3 g6 Bf4
A80 Dutch Defense|d4 f5
B00 King's Pawn Opening|e4
B00 Nimzowitsch Defense|e4 Nc6
B01 Scandinavian Defense|e4 d5
B02 Alekhine's Defense|e4 Nf6
B06 Modern Defense|e4 g6
B07 Pirc Defense|e4 d6
B10 Caro-Kann Defense|e4 c6
B12 Caro-Kann Defense: Advance Variation|e4 c6 d4 d5 e5
B13 Caro-Kann Defense: Exchange Variation|e4 c6 d4 d5 exd5
B20 Sicilian Defense|e4 c5
B22 Sicilian Defense: Alapin Variation|e4 c5 c3
B23 Sicilian Defense: Closed|e4 c5 Nc3
B27 Sicilian Defense|e4 c5 Nf3
B30 Sicilian Defense: Old Sicilian|e4 c5 Nf3 Nc6
B40 Sicilian Defense: French Variation|e4 c5 Nf3 e6
B50 Sicilian Defense|e4 c5 Nf3 d6
B54 Sicilian Defense: Open|e4 c5 Nf3 d6 d4 cxd4 Nxd4
B90 Sicilian Defense: Najdorf Variation|e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6
B70 Sicilian Defense: Dragon Variation|e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6
C00 French Defense|e4 e6
C02 French Defense: Advance Variation|e4 e6 d4 d5 e5
C01 French Defense: Exchange Variation|e4 e6 d4 d5 exd5
C03 French Defense: Tarrasch Variation|e4 e6 d4 d5 Nd2
C10 French Defense: Paulsen Variation|e4 e6 d4 d5 Nc3
C20 King's Pawn Game|e4 e5
C23 Bishop's Opening|e4 e5 Bc4
C25 Vienna Game|e4 e5 Nc3
C30 King's Gambit|e4 e5 f4
C40 King's Knight Opening|e4 e5 Nf3
C41 Philidor Defense|e4 e5 Nf3 d6
C42 Petrov's Defense|e4 e5 Nf3 Nf6
C44 King's Pawn Game|e4 e5 Nf3 Nc6
C44 Scotch Game|e4 e5 Nf3 Nc6 d4
C45 Scotch Game|e4 e5 Nf3 Nc6 d4 exd4 Nxd4
C46 Three Knights Opening|e4 e5 Nf3 Nc6 Nc3
C47 Four Knights Game|e4 e5 Nf3 Nc6 Nc3 Nf6
C50 Italian Game|e4 e5 Nf3 Nc6 Bc4
C50 Italian Game: Giuoco Piano|e4 e5 Nf3 Nc6 Bc4 Bc5
C51 Italian Game: Evans Gambit|e4 e5 Nf3 Nc6 Bc4 Bc5 b4
C53 Italian Game: Classical Variation|e4 e5 Nf3 Nc6 Bc4 Bc5 c3
C55 Italian Game: Two Knights Defense|e4 e5 Nf3 Nc6 Bc4 Nf6
C60 Ruy Lopez|e4 e5 Nf3 Nc6 Bb5
C65 Ruy Lopez: Berlin Defense|e4 e5 Nf3 Nc6 Bb5 Nf6
C68 Ruy Lopez: Exchange Variation|e4 e5 Nf3 Nc6 Bb5 a6 Bxc6
C70 Ruy Lopez: Morphy Defense|e4 e5 Nf3 Nc6 Bb5 a6
C78 Ruy Lopez: Morphy Defense|e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6
C84 Ruy Lopez: Closed|e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7
D00 Queen's Pawn Game|d4 d5
D02 Queen's Pawn Game: London System|d4 d5 Nf3 Nf6 Bf4
D00 London System|d4 d5 Bf4
D06 Queen's Gambit|d4 d5 c4
D10 Slav Defense|d4 d5 c4 c6
D20 Queen's Gambit Accepted|d4 d5 c4 dxc4
D30 Queen's Gambit Declined|d4 d5 c4 e6
D35 Queen's Gambit Declined|d4 d5 c4 e6 Nc3 Nf6
D80 Grunfeld Defense|d4 Nf6 c4 g6 Nc3 d5
E00 Indian Game|d4 Nf6 c4 e6
E10 Indian Game|d4 Nf6 c4 e6 Nf3
E12 Queen's Indian Defense|d4 Nf6 c4 e6 Nf3 b6
E20 Nimzo-Indian Defense|d4 Nf6 c4 e6 Nc3 Bb4
E60 King's Indian Defense|d4 Nf6 c4 g6
E61 King's Indian Defense|d4 Nf6 c4 g6 Nc3 Bg7
E90 King's Indian Defense: Normal Variation|d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3
A56 Benoni Defense|d4 Nf6 c4 c5
A57 Benko Gambit|d4 Nf6 c4 c5 d5 b5
"""


def _parse() -> List[Tuple[str, List[str]]]:
    out = []
    for line in _LINES.strip().splitlines():
        name, moves = line.split("|")
        out.append((name.strip(), moves.split()))
    return out


OPENINGS = _parse()


def classify(start_fen: str, sans: List[str]) -> Tuple[Optional[str], int]:
    """(opening name or None, number of leading plies that follow a known line)."""
    if start_fen != chess.STARTING_FEN:
        return None, 0
    best_name, best_len = None, 0
    for name, line in OPENINGS:
        if len(line) <= len(sans) and sans[:len(line)] == line and len(line) >= best_len:
            if len(line) > best_len or best_name is None:
                best_name, best_len = name, len(line)
    return best_name, best_len
