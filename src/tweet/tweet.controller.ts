import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { TweetService } from './tweet.service';

@Controller('tweets')
export class TweetController {
    constructor(private tweetService: TweetService){} 

    @Get('/:userid')
    public GetTweets(@Param('userid', ParseIntPipe) userid:number){

         return this.tweetService.getTweetsByUserId(userid);
    }
}
