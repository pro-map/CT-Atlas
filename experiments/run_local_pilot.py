#!/usr/bin/env python3
"""Run ONE synthetic API test per selected model, with credentials only in RAM.

Intended for a trusted local Windows PC. No GitHub secrets, Docker, HTTP
redirects, publication, log files, CT ATLAS D1, or production data.
"""
from __future__ import annotations

import getpass
import sys
from pathlib import Path

try:
    import external_llm_pilot as pilot
except ModuleNotFoundError as exc:
    print("DEPENDANCE MANQUANTE : installe requests avec : py -3 -m pip install requests")
    raise SystemExit(2) from exc


def ask_free(name: str) -> bool:
    answer = input(
        f"Le tableau de bord {name} affiche bien un forfait GRATUIT (sans facturation IA) ? [oui/non] : "
    ).strip().lower()
    return answer in ("oui", "o", "yes", "y")


def make_env(provider: str) -> dict[str, str] | None:
    if provider == "groq":
        if not ask_free("Groq / Free Plan"):
            print("Groq non lance : forfait non confirme.")
            return None
        key = getpass.getpass("Cle API Groq (saisie masquee, jamais sauvegardee) : ").strip()
        return {
            "EXTERNAL_LLM_PILOT_EXPLICIT_OPT_IN": "YES",
            "GROQ_FREE_PLAN_VERIFIED": "YES",
            "GROQ_API_KEY": key,
        }

    if not ask_free("Cloudflare Workers / Free"):
        print("Cloudflare non lance : forfait non confirme.")
        return None
    account = input("Cloudflare Account ID (32 caracteres hexadecimaux) : ").strip()
    key = getpass.getpass(
        "Cle API Workers AI Cloudflare (saisie masquee, jamais sauvegardee) : "
    ).strip()
    return {
        "EXTERNAL_LLM_PILOT_EXPLICIT_OPT_IN": "YES",
        "CLOUDFLARE_WORKERS_AI_FREE_PLAN_VERIFIED": "YES",
        "CLOUDFLARE_AI_ACCOUNT_ID": account,
        "CLOUDFLARE_AI_API_TOKEN": key,
    }


def main() -> int:
    print("=" * 68)
    print("CT ATLAS - Test local de 2 IA - DONNEES 100% FICTIVES")
    print("=" * 68)
    print("Groq GPT-OSS 120B: classification d'UN article fictif.")
    print("Cloudflare GLM-4.7-Flash: traduction d'UN titre fictif.")
    print("Aucune donnee INTERPOL, Dark Web, carte, quota Gemini ou facturation")
    print("n'est modifiee. Les cles ne sont ni affichees ni sauvegardees.")
    print("Les reponses imprimees sont des metriques agregees.")
    print()
    choice = input("Tester [1] Groq, [2] Cloudflare, [3] les deux ? [3] : ").strip()
    if choice not in ("", "1", "2", "3"):
        print("Choix incorrect; aucun appel.")
        return 2
    selected = (["groq"] if choice == "1" else
                ["cloudflare"] if choice == "2" else
                ["groq", "cloudflare"])
    if input(
        "Autorises-tu un appel API maximum PAR modele sur des exemples fictifs, "
        "sans aucune donnee reelle ? [oui/non] : "
    ).strip().lower() not in ("oui", "o", "yes", "y"):
        print("Aucun appel effectue.")
        return 0

    # Validate the complete synthetic fixture once BEFORE entering any secret.
    cases = pilot.load_fixtures()
    print(f"Jeu local controle : {len(cases)} cas fictifs (seulement le premier par modele est envoye).")
    had_failure = False
    for provider in selected:
        print(f"\n>>> Fournisseur : {provider.upper()}")
        type_name = "classification" if provider == "groq" else "translation"
        available = len([x for x in cases if x["task"] == type_name])
        raw = input(
            f"Numero de l'exemple FICTIF a evaluer pour {provider} (1-{available}) [1] : "
        ).strip()
        if raw and (not raw.isdecimal() or not 1 <= int(raw) <= available):
            had_failure = True
            print("Numero invalide. Aucun appel a cette IA.")
            continue
        start_at = (int(raw) if raw else 1) - 1
        env = make_env(provider)
        if env is None:
            continue
        try:
            # Pilot enforces: separate free-tier approval, <=2 synthetic items
            # per provider, known HTTPS origin, NO redirects and NO retries.
            pilot.main(
                ["--mode", "live", "--provider", provider, "--max-per-provider", "1",
                 "--start-at", str(start_at), "--show-synthetic-comparisons"],
                env=env,
            )
        except pilot.PilotSafetyError as exc:
            had_failure = True
            print(f"Test refuse/arreté sans relance : {exc}")
        except Exception:
            had_failure = True
            # Never stringify unexpected errors; libraries might echo a key.
            print("Erreur inattendue, aucun nouveau test automatique. Controle technique necessaire.")
        finally:
            # No secret was written to an OS environment variable or disk.
            env.clear()
    print("\nTERMINE. Tu peux copier ici les metriques ET les traductions fictives")
    print("affichees, car seules des donnees inventees sont traitees.")
    print("N'envoie JAMAIS les cles API, Account ID, captures des entrees masquees,")
    print("ni des donnees CT ATLAS/INTERPOL/Dark Web.")
    return 1 if had_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
