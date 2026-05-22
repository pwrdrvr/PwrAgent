# Local preview only — not used by GitHub Pages.
# Builds a self-contained Jekyll serve container with the site contents
# baked in (no bind mount required, so it works under restricted Docker
# Desktop / colima configurations).
#
# Build + run from the repo root:
#
#   docker build -t pwragent-docs-site:local docs-site/
#   docker run --rm -it -p 4000:4000 pwragent-docs-site:local
#
# Then open http://localhost:4000/.

FROM ruby:4.0-slim

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends build-essential git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/jekyll

# Pin to the bundler 2.x line so we don't pick up the pre-release 4.x.
RUN gem install bundler:'~> 2.5' --no-document

COPY Gemfile ./
RUN bundle install --jobs 4

COPY . ./

EXPOSE 4000

CMD ["bundle", "exec", "jekyll", "serve", "--host", "0.0.0.0", "--port", "4000"]
