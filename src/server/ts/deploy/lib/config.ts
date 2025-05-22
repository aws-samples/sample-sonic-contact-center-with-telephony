interface ConfigProps {
  indexLambdaDir: string;
}

class Config {
  readonly indexLambdaDir: string;

  constructor(props: ConfigProps) {
    this.indexLambdaDir = props.indexLambdaDir;
  }
}

const config = new Config({
  indexLambdaDir: "./lambdas/indexes/"
});

export default config;
