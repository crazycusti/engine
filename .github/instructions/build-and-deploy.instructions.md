
## Build and Deployment

### Build Process

- In package.json are all depencencies and scripts needed for building the project.
- Use `npm install` to install dependencies.
- Use `npm run build:production` to build the project.

### Deployment

- Output files will be in the `dist/` directory after a successful build.
- Build and Deployment is automatically done by Cloudflare Worker.

### Three different kinds of builds

We need to make sure the correct build is used at all times.

1. Dedicated development server: The code is executed in node.js directly, no build step required.
2. Dedicated production server: The code is built using `npm run build:production` and the output files in `dist/` are executed in node.js. This is required to strip out all console.assert statements and other development-only code for optimal performance.
3. Client code: The code is built using `npm run build:production` and the output files in `dist/` are executed in the browser.
