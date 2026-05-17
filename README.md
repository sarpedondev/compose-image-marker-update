# Compose Image Marker Update

A GitHub Action for updating Docker Compose `image:` lines using marker comments.

It is designed for simple GitOps flows where your CI builds an image, pushes it to a registry, then updates an infra repository with the new immutable image tag.

## Why

Most image update tools require knowing the exact YAML path to update.

This action does not. It updates any Compose image line that contains a marker comment:

```yaml
services:
  backend:
    image: sarpedondev/example:backend-old # image-tag:backend
```

After the action runs:

```yaml
services:
  backend:
    image: sarpedondev/example:backend-master-20260517141000-a1b2c3d4e5f6 # image-tag:backend
```

This works well with split Compose files, Swarm stacks, Komodo Resource Syncs, and small GitOps repos.

## Usage

```yaml
- name: Update backend image
  uses: sarpedondev/compose-image-marker-update@v1
  with:
    repo: MyProject/Infra
    branch: master
    token: ${{ secrets.INFRA_REPO_TOKEN }}
    marker: backend
    image: sarpedondev/example:backend-master-20260517141000-a1b2c3d4e5f6
    files: |
      exampleclient/prod/*.yml
      exampleclient/prod/*.yaml
```

## Compose marker format

Add a marker comment to the image line you want the action to manage:

```yaml
services:
  backend:
    image: sarpedondev/example:backend-current # image-tag:backend
```

The marker name must match the `marker` input:

```yaml
marker: backend
```

You can use any marker name:

```yaml
image: sarpedondev/example:frontend-current # image-tag:frontend
image: sarpedondev/example:worker-current # image-tag:worker
image: ghcr.io/acme/api:old # image-tag:api
```

## Inputs

| Input             | Required | Default                                        | Description                                                  |
| ----------------- | -------: | ---------------------------------------------- | ------------------------------------------------------------ |
| `repo`            |       No | Current repository                             | Repository to update, for example `owner/repo`.              |
| `branch`          |       No | `main`                                         | Branch to update.                                            |
| `token`           |      Yes |                                                | GitHub token with write access to the target repository.     |
| `image`           |      Yes |                                                | Full image reference to write.                               |
| `marker`          |      Yes |                                                | Marker name. The action searches for `# image-tag:<marker>`. |
| `files`           |       No | `**/*.yml`, `**/*.yaml`                        | Newline-separated glob patterns to search.                   |
| `marker-prefix`   |       No | `image-tag`                                    | Marker prefix.                                               |
| `commit-message`  |       No | Auto-generated                                 | Commit message to use.                                       |
| `git-user-name`   |       No | `github-actions[bot]`                          | Git commit author name.                                      |
| `git-user-email`  |       No | `github-actions[bot]@users.noreply.github.com` | Git commit author email.                                     |
| `fail-on-missing` |       No | `true`                                         | Warn or fail on missing image-tag marker.                    |

## Outputs

| Output    | Description                                     |
| --------- | ----------------------------------------------- |
| `changed` | `true` if the action changed at least one file. |
| `files`   | Comma-separated list of changed files.          |

## Example: build image, then update infra repo

```yaml
name: Build backend Docker image

on:
  push:
    branches:
      - "**"

jobs:
  docker:
    runs-on: ubuntu-latest

    outputs:
      image: ${{ steps.meta.outputs.image }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Compute image tag
        id: meta
        shell: bash
        run: |
          SHORT_SHA="$(git rev-parse --short=12 HEAD)"
          TS="$(date -u +%Y%m%d%H%M%S)"
          BRANCH="${GITHUB_REF_NAME}"
          SAFE_BRANCH="$(echo "$BRANCH" | tr '/[:upper:]' '-[:lower:]' | sed 's/[^a-z0-9_.-]/-/g')"

          TAG="backend-${SAFE_BRANCH}-${TS}-${SHORT_SHA}"
          IMAGE="${{ secrets.DOCKER_USERNAME }}/example:${TAG}"

          echo "image=${IMAGE}" >> "$GITHUB_OUTPUT"

      - name: Log in to Docker Hub
        uses: docker/login-action@v4
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_TOKEN }}

      - name: Build image
        run: |
          docker build -t "${{ steps.meta.outputs.image }}" .

      - name: Push image
        run: |
          docker push "${{ steps.meta.outputs.image }}"

  update-infra:
    needs: docker
    runs-on: ubuntu-latest

    steps:
      - name: Update backend image in infra repo
        uses: sarpedondev/compose-image-marker-update@v1
        with:
          repo: MyProject/Infra
          branch: master
          token: ${{ secrets.INFRA_REPO_TOKEN }}
          marker: backend
          image: ${{ needs.docker.outputs.image }}
          files: |
            exampleclient/prod/*.yml
            exampleclient/prod/*.yaml
```

## Token permissions

When updating the same repository, the default `GITHUB_TOKEN` may be enough if workflow permissions allow writing:

```yaml
permissions:
  contents: write
```

When updating a different repository, use a fine-grained personal access token or GitHub App token with write access to that repository.

Store it as a secret, for example:

```text
INFRA_REPO_TOKEN
```

## What gets changed

Only lines that contain both:

```text
image:
```

and:

```text
# image-tag:<marker>
```

are updated.

For example, with `marker: backend`, this line changes:

```yaml
image: sarpedondev/example:old # image-tag:backend
```

This line does not:

```yaml
image: postgres:16
```

This line also does not:

```yaml
image: sarpedondev/example:old # image-tag:frontend
```

## Quoted images

The action preserves simple quote style:

```yaml
image: "sarpedondev/example:old" # image-tag:backend
```

becomes:

```yaml
image: "sarpedondev/example:new" # image-tag:backend
```

## Recommended GitOps pattern

Use immutable image tags in production Compose files:

```yaml
image: sarpedondev/example:backend-master-20260517141000-a1b2c3d4e5f6 # image-tag:backend
```

Avoid relying only on mutable tags like:

```yaml
image: sarpedondev/example:backend-master
```

Mutable tags are convenient, but immutable tags make rollbacks and audits much easier.

## License

MIT
