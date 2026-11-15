.PHONY: check check-web

BPMN := docs/processo/processo-atual.bpmn docs/processo/processo-alvo.bpmn

# O web/ instala os kits do GitHub Packages, que pedem token até para ler (#60). Só o `check-web` o
# usa. Local, o do `gh`; na esteira, o GITHUB_TOKEN que o workflow exporta.
export NODE_AUTH_TOKEN ?= $(shell gh auth token 2>/dev/null)

# Os testes online da base do kit (scripts/kit_online_test.py, #52) pulam sem as credenciais do Supabase.
check:
	@python3 scripts/validar_bpmn.py $(BPMN)
	@python3 -m unittest discover -s scripts -p '*_test.py'
	@npm --prefix api ci --no-audit --no-fund --loglevel=error
	@npm --prefix api run typecheck
	@npm --prefix api test

# A parte web/ saiu do gate (#25): a conta do grupo e o CI do fork não leem os pacotes
# @barte-ai-services/* (403) e o acesso não será concedido. Quem tiver acesso roda `make check-web`.
check-web:
	@npm --prefix web ci --no-audit --no-fund --loglevel=error
	@npm --prefix web run typecheck
	@npm --prefix web test
	@npm --prefix web run build
