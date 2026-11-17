.PHONY: check check-web

BPMN := docs/processo/processo-atual.bpmn docs/processo/processo-alvo.bpmn

# Os testes online da base do kit (scripts/kit_online_test.py, #52) pulam sem as credenciais do Supabase.
check:
	@python3 scripts/validar_bpmn.py $(BPMN)
	@python3 -m unittest discover -s scripts -p '*_test.py'
	@npm --prefix api ci --no-audit --no-fund --loglevel=error
	@npm --prefix api run typecheck
	@npm --prefix api test
	@$(MAKE) --no-print-directory check-web

# O web/ (#53): o `npm ci` pula os kits privados da Barte (`optionalDependencies`, que o GitHub Packages nega a este
# fork), e a tela roda nos substitutos de `web/src/stand-ins/`. Nenhum token é preciso. Com acesso aos pacotes, o
# `npm ci` os instala e a tela usa os reais.
check-web:
	@npm --prefix web ci --no-audit --no-fund --loglevel=error
	@npm --prefix web run typecheck
	@npm --prefix web test
	@npm --prefix web run build
