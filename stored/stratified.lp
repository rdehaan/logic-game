has_choice :- rule(choice(_),_).

has_proper_disjunction :-
    rule(disjunction(T),_),
    atom_tuple(T,A1),
    atom_tuple(T,A2), A1 != A2.

dependency(Atom,Body,plus) :-
    rule(disjunction(Tuple),Body),
    atom_tuple(Tuple,Atom).
dependency(Atom,Body,plus) :-
    rule(choice(Tuple),Body),
    atom_tuple(Tuple,Atom).
dependency(normal(Tuple),Atom,plus) :-
    rule(_,normal(Tuple)),
    literal_tuple(Tuple,Atom), Atom > 0.
dependency(normal(Tuple),Atom,minus) :-
    rule(_,normal(Tuple)),
    literal_tuple(Tuple,-Atom), Atom > 0.
dependency(sum(Tuple,Sum),Atom,plus) :-
    rule(_,sum(Tuple,Sum)),
    weighted_literal_tuple(Tuple,Atom,_), Atom > 0.
dependency(sum(Tuple,Sum),Atom,minus) :-
    rule(_,sum(Tuple,Sum)),
    weighted_literal_tuple(Tuple,-Atom,_), Atom > 0.
dependency(A,C,plus) :- dependency(A,B,plus), dependency(B,C,plus).
dependency(A,C,minus) :- dependency(A,B,minus), dependency(B,C,_).
dependency(A,C,minus) :- dependency(A,B,_), dependency(B,C,minus).
has_negative_cycle :- dependency(A,B,minus), dependency(B,A,_).

:- has_negative_cycle.
:- has_proper_disjunction.
:- has_choise.
